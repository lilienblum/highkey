// The ingest app reads keys from highkey.ingest_keys. The management database stays the source of truth: every key,
// source or retention change is mirrored after it commits, and `reconcile` rewrites the whole
// registry every minute, recreates whatever project access ClickHouse is missing (all of it when
// a release changes what access looks like), applies retention changes that have not reached the
// stored rows yet, and starts the wipe of a project whose 7-day grace has passed. Under Tako this
// runs as the `reconcile` workflow.
import type { ApiContext } from "./api/context";
import { accessVersion, ensureProjectAccess, id32, provisionedProjects } from "./clickhouse/access";
import { all, type Db, one } from "./db/db";
import { logRetention } from "./db/keys";
import { projectMissing } from "./api/errors";
import { productRow, products } from "./db/products";
import { dueWipe, type WipePayload, wipeProject } from "./wipe";

interface KeyRow {
  hash: string;
  product_id: string;
  source_id: string;
  allowed_origins: string;
  revoked: number;
}

const stamp = () => new Date().toISOString().replace("T", " ").replace("Z", "");

async function rows(ctx: ApiContext, productId: string, keyId?: string) {
  const project = await one<{ retention_days: number; deleted_at: string | null }>(
    ctx.db,
    "SELECT retention_days, deleted_at FROM products WHERE id = ?",
    [productId],
  );
  if (!project) throw projectMissing();
  const eventRetention = project.retention_days;
  // A deleted project's keys stop at once, without losing which were revoked before (a restore
  // brings them back as they were).
  const stopped = project.deleted_at !== null;
  const logDays = await logRetention(ctx.db, productId);
  const where = keyId ? "product_id = ? AND id = ?" : "product_id = ?";
  const args = keyId ? [productId, keyId] : [productId];
  const events = await all<KeyRow>(
    ctx.db,
    `SELECT hash, product_id, source_id, allowed_origins, revoked FROM ingestion_keys WHERE ${where}`,
    args,
  );
  const logs = await all<KeyRow>(
    ctx.db,
    `SELECT hash, product_id, source_id, '[]' AS allowed_origins, revoked FROM log_keys WHERE ${where}`,
    args,
  );
  const updated_at = stamp();
  return [
    ...events.map((row) => ({ ...row, kind: "events", retention_days: eventRetention })),
    ...logs.map((row) => ({ ...row, kind: "logs", retention_days: logDays })),
  ].map((row) => ({
    hash: row.hash,
    kind: row.kind,
    product_id: row.product_id,
    source_id: row.source_id,
    allowed_origins: JSON.parse(row.allowed_origins) as string[],
    retention_days: row.retention_days,
    revoked: stopped ? 1 : row.revoked,
    updated_at,
  }));
}

/** Mirrors one key (either kind). */
export async function mirrorKey(ctx: ApiContext, productId: string, keyId: string): Promise<void> {
  await ctx.admin.insert("highkey.ingest_keys", await rows(ctx, productId, keyId));
}

/** Mirrors every key of a project, with its current retention. */
export async function mirrorProject(ctx: ApiContext, productId: string): Promise<number> {
  const found = await rows(ctx, productId);
  await ctx.admin.insert("highkey.ingest_keys", found);
  return found.length;
}

/** Runs a mirror step after a committed change; a failure waits for the next reconcile. */
export async function afterCommit(step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch (error) {
    console.warn("ClickHouse update failed; the next reconcile repairs it", error);
  }
}

/** Points a project's stored rows at its retention, so TTL keeps them for exactly that long. */
export async function applyRetention(
  ctx: ApiContext,
  productId: string,
  table: "highkey.events" | "highkey.logs",
  days: number,
): Promise<void> {
  const time = table === "highkey.events" ? "event_time" : "timestamp";
  await ctx.admin.command(
    `ALTER TABLE ${table} UPDATE expires_at = toDateTime(${time}) + toIntervalDay({days:UInt16}) WHERE product_id = {product:UUID}`,
    { params: { days, product: productId }, settings: { mutations_sync: 2 } },
  );
}

/** The ingest app caches a key, with its retention, for up to this long. */
const KEY_CACHE_MS = 5_000;
/** Registry rows per insert when reconcile rewrites the registry. */
const MIRROR_CHUNK = 10_000;

type Signal = "events" | "logs";
const TABLES = { events: "highkey.events", logs: "highkey.logs" } as const;

/**
 * Records that a project's stored rows must follow its new retention. Call it in the transaction
 * that changes the retention, so the change cannot be lost if ClickHouse is unreachable.
 */
export async function retentionChanged(
  db: Db,
  now: Date,
  productId: string,
  signal: Signal,
): Promise<void> {
  await db.execute(
    "INSERT INTO retention_changes(product_id, signal, due_ms, final) VALUES (?, ?, ?, 0) ON CONFLICT(product_id, signal) DO UPDATE SET due_ms = excluded.due_ms, final = 0",
    [productId, signal, now.getTime()],
  );
}

/**
 * Applies the retention changes that are due, for one project or all. Each first mirrors the
 * project's keys, so the ingest app stamps new rows with the new retention once its cache has
 * expired, then rewrites the stored rows' expiry. It runs once more after that cache has passed,
 * for rows stored meanwhile with the old retention. A failure leaves the change due for the next
 * reconcile. Returns how many failed.
 */
export async function applyRetentionChanges(ctx: ApiContext, productId?: string): Promise<number> {
  const due = await all<{
    product_id: string;
    signal: Signal;
    due_ms: number;
    final: number;
  }>(
    ctx.db,
    `SELECT product_id, signal, due_ms, final FROM retention_changes WHERE due_ms <= ?${productId ? " AND product_id = ?" : ""}`,
    [ctx.now().getTime(), ...(productId ? [productId] : [])],
  );
  let failed = 0;
  for (const change of due) {
    try {
      await mirrorProject(ctx, change.product_id);
      const days =
        change.signal === "events"
          ? (await productRow(ctx.db, change.product_id)).retention_days
          : await logRetention(ctx.db, change.product_id);
      await applyRetention(ctx, change.product_id, TABLES[change.signal], days);
      // Only if no newer change arrived meanwhile; a newer one starts over.
      const same = "WHERE product_id = ? AND signal = ? AND due_ms = ? AND final = ?";
      const args = [change.product_id, change.signal, change.due_ms, change.final];
      if (change.final) await ctx.db.execute(`DELETE FROM retention_changes ${same}`, args);
      else
        await ctx.db.execute(`UPDATE retention_changes SET final = 1, due_ms = ? ${same}`, [
          ctx.now().getTime() + KEY_CACHE_MS + 1_000,
          ...args,
        ]);
    } catch (error) {
      failed++;
      console.warn(
        `Retention change for project ${change.product_id} not applied; the next reconcile retries it`,
        error,
      );
    }
  }
  return failed;
}

/**
 * Repairs what ClickHouse should hold. `full` re-creates every project's access, as the first
 * reconcile after a start does, so new view definitions and reader settings take effect; other
 * runs re-create only what is missing. One project's failure does not stop the others.
 */
export async function reconcile(
  ctx: ApiContext,
  options: { full?: boolean } = {},
): Promise<{ projects: number; keys: number; failed: number }> {
  const projects = await products(ctx.db);
  const ready = options.full ? new Set<string>() : await provisionedProjects(ctx.admin);
  let failed = 0;
  const deleted = new Set(
    (await all<{ id: string }>(ctx.db, "SELECT id FROM products WHERE deleted_at IS NOT NULL")).map(
      (row) => row.id,
    ),
  );
  for (const project of projects) {
    // A deleted project keeps its access until its wipe drops it; never re-create it.
    if (ready.has(id32(project.id)) || deleted.has(project.id)) continue;
    try {
      await ensureProjectAccess(ctx.admin, project.id, ctx.secret);
    } catch (error) {
      failed++;
      console.warn(
        `Access for project ${project.id} not created; the next reconcile retries`,
        error,
      );
    }
  }
  const keys = (await Promise.all(projects.map((project) => rows(ctx, project.id)))).flat();
  for (let start = 0; start < keys.length; start += MIRROR_CHUNK)
    await ctx.admin.insert("highkey.ingest_keys", keys.slice(start, start + MIRROR_CHUNK));
  failed += await applyRetentionChanges(ctx);
  return { projects: projects.length, keys: keys.length, failed };
}

/**
 * One scheduled reconcile: a full pass when project access in this release (or the reader
 * secret) differs from what the last full pass recorded, otherwise only what is missing. The
 * version is recorded after a full pass in which nothing failed.
 */
export async function reconcileOnce(
  ctx: ApiContext,
  options: { wipe?: (payload: WipePayload) => Promise<unknown> } = {},
): Promise<{ projects: number; keys: number; failed: number; full: boolean }> {
  const current = accessVersion(ctx.secret);
  const stored = await one<{ value: string }>(
    ctx.db,
    "SELECT value FROM settings WHERE key = 'access_version'",
  );
  const full = stored?.value !== current;
  const result = await reconcile(ctx, { full });
  if (full && result.failed === 0)
    await ctx.db.execute(
      "INSERT INTO settings(key, value) VALUES ('access_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [current],
    );
  // Then the oldest project past its 7-day grace: enqueued as a `wipe-project` run under Tako
  // (a repeat enqueue is a no-op), wiped in place without it.
  const due = await dueWipe(ctx.db, ctx.now());
  if (due) {
    const wipe = options.wipe ?? ((payload: WipePayload) => wipeProject(ctx, payload));
    await wipe(due).catch((error) => {
      result.failed++;
      console.warn(`Wiping project ${due.project} failed; the next reconcile retries`, error);
    });
  }
  return { ...result, full };
}

/** Deletes expired rows now, rather than at the next TTL merge. */
export async function cleanup(ctx: ApiContext): Promise<{ removed: number; logs_removed: number }> {
  const expired = async (table: string) => {
    const result = await ctx.admin.query<{ n: number }>(
      `SELECT count() AS n FROM ${table} WHERE expires_at < now()`,
    );
    await ctx.admin.command(`ALTER TABLE ${table} MATERIALIZE TTL`, {
      settings: { mutations_sync: 2 },
    });
    return Number(result.data[0]?.n ?? 0);
  };
  return { removed: await expired("highkey.events"), logs_removed: await expired("highkey.logs") };
}
