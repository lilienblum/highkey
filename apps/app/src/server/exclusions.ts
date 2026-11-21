import { isIP } from "node:net";
import { fields, readJson } from "./api/body";
import { bad, json } from "./api/errors";
import { route } from "./api/router";
import { type ApiContext } from "./api/context";
import { one, all } from "./db/db";
import { validKey } from "./queries/properties";
export interface Exclusions {
  networks: string[];
  profiles: string[];
  rules: { event: string; property: string; op: string; value: string | number | boolean | null }[];
}
const empty: Exclusions = { networks: [], profiles: [], rules: [] };
export function parseExclusions(input: unknown): Exclusions {
  const q = fields(input, { networks: "string[]", profiles: "string[]", rules: "unknown" }, empty);
  if (
    q.networks.length > 64 ||
    q.profiles.length > 256 ||
    !Array.isArray(q.rules) ||
    q.rules.length > 32
  )
    throw bad("Use at most 64 networks, 256 profile IDs and 32 event rules");
  for (const cidr of q.networks) {
    const [address, prefix, ...rest] = cidr.split("/"),
      family = isIP(address);
    if (
      !family ||
      address.includes("%") ||
      !/^(0|[1-9]\d{0,2})$/.test(prefix ?? "") ||
      Number(prefix) > (family === 4 ? 32 : 128) ||
      rest.length
    )
      throw bad("Use an IPv4 or IPv6 network with a CIDR prefix");
  }
  if (q.profiles.some((v) => !v || new TextEncoder().encode(v).length > 128))
    throw bad("Profile IDs must be 1–128 bytes");
  const rules = q.rules.map((raw) => {
    const r = fields(
      raw,
      { event: "string", property: "string", op: "string", value: "unknown" },
      { event: "", property: "", op: "eq", value: null },
    );
    if (
      (r.event && !validKey(r.event)) ||
      (r.property && !validKey(r.property)) ||
      (!r.event && !r.property) ||
      !["eq", "contains", "starts_with", "ends_with"].includes(r.op) ||
      (r.property &&
        (r.op === "eq"
          ? !["string", "boolean", "number"].includes(typeof r.value)
          : typeof r.value !== "string" || !r.value)) ||
      String(r.value).length > 512
    )
      throw bad("Each rule needs a raw event name or a typed property comparison");
    return { ...r, value: r.property ? (r.value as string | number | boolean) : null };
  });
  return { networks: [...new Set(q.networks)], profiles: [...new Set(q.profiles)], rules };
}
export async function mirrorExclusions(ctx: ApiContext, id?: string) {
  const rows = await all<{ product_id: string; policy: string }>(
    ctx.db,
    `SELECT e.product_id,e.policy FROM collection_exclusions e JOIN products p ON e.product_id=p.id WHERE p.deleted_at IS NULL${id ? " AND e.product_id=?" : ""}`,
    id ? [id] : [],
  );
  if (rows.length) await ctx.admin.insert("highkey.collection_exclusions", rows);
}
export function registerExclusions() {
  const path = "/api/products/:project/exclusions";
  route("GET", path, { project: ["update"] }, async (_r, ctx, { project }) => {
    const row = await one<{ policy: string }>(
      ctx.db,
      "SELECT policy FROM collection_exclusions WHERE product_id=?",
      [project!],
    );
    return json(row ? JSON.parse(row.policy) : empty);
  });
  route("PUT", path, { project: ["update"] }, async (r, ctx, { project }) => {
    const policy = parseExclusions(await readJson(r));
    await ctx.db.execute(
      "INSERT INTO collection_exclusions(product_id,policy) VALUES(?,?) ON CONFLICT(product_id) DO UPDATE SET policy=excluded.policy",
      [project!, JSON.stringify(policy)],
    );
    await mirrorExclusions(ctx, project);
    return json(policy);
  });
}
