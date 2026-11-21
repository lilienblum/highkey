import { createHash } from "node:crypto";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { tako } from "tako.sh";
import { fields, readJson } from "./api/body";
import { type ApiContext } from "./api/context";
import { bad, json } from "./api/errors";
import { route } from "./api/router";
import { all, changes, one } from "./db/db";
import { readAs } from "./queries/read";
const compress = promisify(gzip);
type Signal = "events" | "logs";
type Stream = {
  product_id: string;
  signal: Signal;
  cursor_ms: number;
  cursor_id: string;
  pending_key: string | null;
  pending_bytes: Uint8Array | null;
  pending_ms: number | null;
  pending_id: string | null;
};
export type Upload = (key: string, data: Uint8Array) => Promise<void>;
export function configuredExport(): Upload | undefined {
  const secrets = tako.secrets as Record<string, string | undefined>,
    env = (k: string) => secrets[k] ?? process.env[k];
  const bucket = env("HIGHKEY_EXPORT_BUCKET"),
    accessKeyId = env("HIGHKEY_EXPORT_ACCESS_KEY_ID"),
    secretAccessKey = env("HIGHKEY_EXPORT_SECRET_ACCESS_KEY");
  if (!bucket || !accessKeyId || !secretAccessKey) return;
  const client = new Bun.S3Client({
    bucket,
    accessKeyId,
    secretAccessKey,
    endpoint: env("HIGHKEY_EXPORT_ENDPOINT"),
    region: env("HIGHKEY_EXPORT_REGION") ?? "us-east-1",
  });
  return async (key, data) => {
    await client.file(key).write(Buffer.from(data), { type: "application/gzip" });
  };
}
export async function exportBatch(
  ctx: ApiContext,
  project: string,
  signal: Signal,
  upload: Upload,
): Promise<boolean> {
  const args = [project, signal],
    s = await one<Stream>(
      ctx.db,
      "SELECT * FROM export_streams WHERE product_id=? AND signal=? AND enabled=1",
      args,
    );
  if (!s) return false;
  if (!s.pending_key) {
    const end = +ctx.now() - 60000,
      event = signal === "events",
      key = event ? "event_id" : "log_id";
    const cols = event
      ? "event_id,name,source,source_id,event_time,actor_id,identity_kind,session_id,profile_id,groups,properties,country,region,browser,browser_version,os_family,os_version,device,referrer_name,referrer_type,bot,backfill,sdk"
      : "log_id,source_id,timestamp,level,message,service,environment,trace_id,span_id,request_id,attributes";
    const records = (
      await readAs(ctx, project, (r) =>
        r.query<Record<string, unknown> & { ms: number; id: string }>(
          `SELECT toUnixTimestamp64Milli(received_at) AS ms,${key} AS id,${cols},received_at FROM ${event ? "all_events" : "all_logs"} WHERE (received_at,${key})>(fromUnixTimestamp64Milli({ms:Int64}),{id:String}) AND received_at<fromUnixTimestamp64Milli({end:Int64}) ORDER BY received_at,${key} LIMIT 128`,
          {
            params: { ms: s.cursor_ms, id: s.cursor_id, end },
            settings: { SQL_highkey_include_bots: "1" },
          },
        ),
      )
    ).data;
    if (!records.length) return false;
    const lines: string[] = [];
    let n = 0;
    for (const { ms: _, id: __, ...row } of records) {
      const line = JSON.stringify(row),
        size = Buffer.byteLength(line) + 1;
      if (lines.length && n + size > 384 * 1024) break;
      lines.push(line);
      n += size;
    }
    const last = records[lines.length - 1],
      bytes = await compress(lines.join("\n") + "\n");
    const digest = createHash("sha256").update(bytes).digest("hex");
    s.pending_key = `highkey/${project}/${signal}/${new Date(records[0].ms).toISOString().slice(0, 10)}/${records[0].ms}-${digest}.jsonl.gz`;
    s.pending_ms = last.ms;
    s.pending_id = last.id;
    s.pending_bytes = bytes;
    if (
      !(await changes(
        ctx.db,
        "UPDATE export_streams SET pending_key=?,pending_bytes=?,pending_ms=?,pending_id=? WHERE product_id=? AND signal=? AND enabled=1 AND cursor_ms=? AND cursor_id=? AND pending_key IS NULL",
        [s.pending_key, bytes, last.ms, last.id, ...args, s.cursor_ms, s.cursor_id],
      ))
    )
      return false;
  }
  // A retry re-uploads identical compressed bytes to exactly the same private object.
  await upload(s.pending_key, s.pending_bytes!);
  return !!(await changes(
    ctx.db,
    "UPDATE export_streams SET cursor_ms=pending_ms,cursor_id=pending_id,pending_key=NULL,pending_bytes=NULL,pending_ms=NULL,pending_id=NULL,updated_ms=? WHERE product_id=? AND signal=? AND enabled=1 AND pending_key=?",
    [+ctx.now(), ...args, s.pending_key],
  ));
}
export async function exportTick(ctx: ApiContext, upload = configuredExport()) {
  if (!upload) return;
  for (const s of await all<Pick<Stream, "product_id" | "signal">>(
    ctx.db,
    "SELECT product_id,signal FROM export_streams JOIN products p ON product_id=p.id WHERE enabled=1 AND p.deleted_at IS NULL ORDER BY updated_ms",
  )) {
    try {
      for (let i = 0; i < 8 && (await exportBatch(ctx, s.product_id, s.signal, upload)); i++) {}
    } catch {
      console.warn(`Export of ${s.signal} for ${s.product_id} deferred until next minute`);
    }
  }
}
export function registerExports() {
  const path = "/api/products/:project/export";
  route("GET", path, { project: ["update"] }, async (_r, ctx, { project }) =>
    json({
      configured: !!configuredExport(),
      streams: await all(
        ctx.db,
        "SELECT signal,enabled,cursor_ms,updated_ms FROM export_streams WHERE product_id=?",
        [project!],
      ),
    }),
  );
  route("PUT", path, { project: ["update"] }, async (r, ctx, { project }) => {
    const q = fields(await readJson(r), { signal: "string", enabled: "boolean" });
    if (!["events", "logs"].includes(q.signal) || (q.enabled && !configuredExport()))
      throw bad("Configure an export bucket before enabling an events or logs stream");
    if (!q.enabled)
      await ctx.db.execute("DELETE FROM export_streams WHERE product_id=? AND signal=?", [
        project!,
        q.signal,
      ]);
    else
      await ctx.db.execute(
        "INSERT OR IGNORE INTO export_streams(product_id,signal,enabled,cursor_ms) VALUES(?,?,1,?)",
        [project!, q.signal, +ctx.now()],
      );
    return json(q);
  });
}
