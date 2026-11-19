// The ingest app reads keys from highkey.ingest_keys. SQLite stays the source of truth: every key,
// source or retention change is mirrored after it commits, and `reconcile` rewrites the whole
// registry every minute, recreates whatever project access ClickHouse is missing (all of it at
// startup), and applies retention changes that have not reached the stored rows yet.
import type { ApiContext } from "./api/context";
import { ensureProjectAccess, id32, provisionedProjects } from "./clickhouse/access";
import { logRetention } from "./db/keys";
import { productRow, products } from "./db/products";

interface KeyRow {
  hash: string;
  product_id: string;
  source_id: string;
  allowed_origins: string;
  revoked: number;
}

const stamp = () => new Date().toISOString().replace("T", " ").replace("Z", "");

function rows(ctx: ApiContext, productId: string, keyId?: string) {
  const eventRetention = productRow(ctx.store, productId).retention_days;
  const logDays = logRetention(ctx.store, productId);
  const where = keyId ? "product_id = ? AND id = ?" : "product_id = ?";
  const args = keyId ? [productId, keyId] : [productId];
  const events = ctx.store.db
    .query(
      `SELECT hash, product_id, source_id, allowed_origins, revoked FROM ingestion_keys WHERE ${where}`,
    )
    .all(...args) as KeyRow[];
  const logs = ctx.store.db
    .query(
      `SELECT hash, product_id, source_id, '[]' AS allowed_origins, revoked FROM log_keys WHERE ${where}`,
    )
    .all(...args) as KeyRow[];
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
    revoked: row.revoked,
    updated_at,
  }));
}

/** Mirrors one key (either kind). */
export async function mirrorKey(ctx: ApiContext, productId: string, keyId: string): Promise<void> {
  await ctx.admin.insert("highkey.ingest_keys", rows(ctx, productId, keyId));
}

/** Mirrors every key of a project, with its current retention. */
export async function mirrorProject(ctx: ApiContext, productId: string): Promise<number> {
  const found = rows(ctx, productId);
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
export function retentionChanged(ctx: ApiContext, productId: string, signal: Signal): void {
  ctx.store.db
    .query(
      "INSERT INTO retention_changes(product_id, signal, due_ms, final) VALUES (?, ?, ?, 0) ON CONFLICT(product_id, signal) DO UPDATE SET due_ms = excluded.due_ms, final = 0",
    )
    .run(productId, signal, ctx.now().getTime());
}

/**
 * Applies the retention changes that are due, for one project or all. Each first mirrors the
 * project's keys, so the ingest app stamps new rows with the new retention once its cache has
 * expired, then rewrites the stored rows' expiry. It runs once more after that cache has passed,
 * for rows stored meanwhile with the old retention. A failure leaves the change due for the next
 * reconcile. Returns how many failed.
 */
export async function applyRetentionChanges(ctx: ApiContext, productId?: string): Promise<number> {
  const due = ctx.store.db
    .query(
      `SELECT product_id, signal, due_ms, final FROM retention_changes WHERE due_ms <= ?${productId ? " AND product_id = ?" : ""}`,
    )
    .all(...[ctx.now().getTime(), ...(productId ? [productId] : [])]) as {
    product_id: string;
    signal: Signal;
    due_ms: number;
    final: number;
  }[];
  let failed = 0;
  for (const change of due) {
    try {
      await mirrorProject(ctx, change.product_id);
      const days =
        change.signal === "events"
          ? productRow(ctx.store, change.product_id).retention_days
          : logRetention(ctx.store, change.product_id);
      await applyRetention(ctx, change.product_id, TABLES[change.signal], days);
      // Only if no newer change arrived meanwhile; a newer one starts over.
      const same = "WHERE product_id = ? AND signal = ? AND due_ms = ? AND final = ?";
      const args = [change.product_id, change.signal, change.due_ms, change.final] as const;
      if (change.final) ctx.store.db.query(`DELETE FROM retention_changes ${same}`).run(...args);
      else
        ctx.store.db
          .query(`UPDATE retention_changes SET final = 1, due_ms = ? ${same}`)
          .run(ctx.now().getTime() + KEY_CACHE_MS + 1_000, ...args);
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
  const all = products(ctx.store);
  const ready = options.full ? new Set<string>() : await provisionedProjects(ctx.admin);
  let failed = 0;
  for (const project of all) {
    if (ready.has(id32(project.id))) continue;
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
  const keys = all.flatMap((project) => rows(ctx, project.id));
  for (let start = 0; start < keys.length; start += MIRROR_CHUNK)
    await ctx.admin.insert("highkey.ingest_keys", keys.slice(start, start + MIRROR_CHUNK));
  failed += await applyRetentionChanges(ctx);
  return { projects: all.length, keys: keys.length, failed };
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
