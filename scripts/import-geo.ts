// Import a CIDR-only network file; no visitor records or city-level data enter the database.
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { isIP } from "node:net";
import { adminClient } from "../apps/app/src/server/clickhouse/client";
const path = process.argv[2];
if (!path)
  throw new Error("Pass a UTF-8 TSV file: CIDR, ISO country, ISO subdivision, hosting (0 or 1).");
const ch = adminClient(),
  staging = "highkey.geo_import_" + crypto.randomUUID().replaceAll("-", "");
await ch.command(`CREATE TABLE ${staging} AS highkey.geo_networks`);
try {
  const rows: Record<string, unknown>[] = [];
  let count = 0,
    line = 0;
  for await (const text of createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  })) {
    line++;
    if (!text || text.startsWith("#")) continue;
    const values = text.split("\t");
    const [cidr, country, region, hosting = "0"] = values;
    const [network, prefix, ...rest] = cidr.split("/"),
      ip = isIP(network);
    if (
      values.length < 2 ||
      values.length > 4 ||
      rest.length ||
      !ip ||
      !/^\d+$/.test(prefix ?? "") ||
      Number(prefix) > (ip === 4 ? 32 : 128) ||
      !/^[A-Z]{2}$/.test(country) ||
      !/^[A-Z0-9-]{0,12}$/.test(region ?? "") ||
      !["0", "1"].includes(hosting)
    )
      throw new Error(`Invalid network on line ${line}`);
    rows.push({ cidr, country, region: region ?? "", hosting: Number(hosting) });
    count++;
    if (rows.length >= 10000) {
      await ch.insert(staging, rows);
      rows.length = 0;
    }
  }
  if (!count) throw new Error("No networks in the file");
  if (rows.length) await ch.insert(staging, rows);
  const d = (
    await ch.query<{ duplicates: number }>(
      `SELECT count()-uniqExact(cidr) AS duplicates FROM ${staging}`,
    )
  ).data[0];
  if (d.duplicates) throw new Error("Duplicate CIDR ranges");
  await ch.command(`EXCHANGE TABLES highkey.geo_networks AND ${staging}`);
  await ch.command("SYSTEM RELOAD DICTIONARY highkey.geo_lookup");
  console.log(`Loaded ${count} networks.`);
} finally {
  await ch.command(`DROP TABLE IF EXISTS ${staging}`);
}
