// The ingest app reads keys from piko.ingest_keys. SQLite stays the source of truth: every key,
// source or retention change is mirrored after it commits, and `reconcile` rewrites the whole
// registry (and each project's ClickHouse access) at startup and every minute, repairing any
// mirror write that failed.
import type { ApiContext } from "./api/context";
import { ensureProjectAccess } from "./clickhouse/access";
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
  await ctx.admin.insert("piko.ingest_keys", rows(ctx, productId, keyId));
}

/** Mirrors every key of a project, with its current retention. */
export async function mirrorProject(ctx: ApiContext, productId: string): Promise<number> {
  const found = rows(ctx, productId);
  await ctx.admin.insert("piko.ingest_keys", found);
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
  table: "piko.events" | "piko.logs",
  days: number,
): Promise<void> {
  const time = table === "piko.events" ? "event_time" : "timestamp";
  await ctx.admin.command(
    `ALTER TABLE ${table} UPDATE expires_at = toDateTime(${time}) + toIntervalDay({days:UInt16}) WHERE product_id = {product:UUID}`,
    { params: { days, product: productId }, settings: { mutations_sync: 2 } },
  );
}

export async function reconcile(ctx: ApiContext): Promise<{ projects: number; keys: number }> {
  let keys = 0;
  const all = products(ctx.store);
  for (const project of all) {
    await ensureProjectAccess(ctx.admin, project.id, ctx.secret);
    keys += await mirrorProject(ctx, project.id);
  }
  return { projects: all.length, keys };
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
  return { removed: await expired("piko.events"), logs_removed: await expired("piko.logs") };
}
