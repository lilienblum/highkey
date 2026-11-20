import { fields } from "../api/body";
import { bad } from "../api/errors";
import type { ClickHouse } from "../clickhouse/client";

export interface EntityQuery {
  id: string | null;
  type: string | null;
  search: string;
  page: number;
  page_size: number;
}

export function parseEntityQuery(value: unknown): EntityQuery {
  const q = fields(
    value,
    { id: "string?", type: "string?", search: "string", page: "integer", page_size: "integer" },
    { search: "", page: 1, page_size: 50 },
  );
  if (
    q.page < 1 ||
    q.page > 10000 ||
    q.page_size < 1 ||
    q.page_size > 100 ||
    q.search.length > 256 ||
    (q.id != null && (!q.id || new TextEncoder().encode(q.id).length > 128)) ||
    (q.type != null && !/^[a-zA-Z0-9_./-]{1,64}$/.test(q.type))
  )
    throw bad(
      "Use a valid entity id/type, search ≤256 characters, page 1–10000 and page_size 1–100",
    );
  return { ...q, id: q.id ?? null, type: q.type ?? null };
}

/**
 * Read the committed log, not the materialized copies: a failed insert into a dependent view
 * can leave those copies incomplete. Fold each event id once, with its first received payload.
 */
export async function runEntityQuery(
  reader: ClickHouse,
  kind: "profiles" | "groups",
  q: EntityQuery,
) {
  const group = kind === "groups";
  const id = group ? "group_id" : "profile_id";
  const table = group ? "group_records" : "profile_records";
  const identity = group ? "group_type AS type, group_id AS id" : "profile_id AS id";
  const key = group ? "type, id" : "id";
  const params = {
    id: q.id ?? "",
    type: q.type ?? "",
    search: q.search,
    size: q.page_size,
    offset: (q.page - 1) * q.page_size,
  };
  const result = await reader.query<{
    id: string;
    type?: string;
    name?: string;
    first_seen: string;
    last_seen: string;
    traits: Record<string, string>;
    total: number;
  }>(
    `WITH deduped AS (
      SELECT event_id, argMin(tuple(${id}, ${group ? "group_type, group_name," : ""} event_time, traits, increments), received_at) AS row
      FROM ${table} GROUP BY event_id
    ), records AS (
      SELECT event_id, row.1 AS ${id},
        ${group ? "row.2 AS group_type, row.3 AS group_name," : ""}
        row.${group ? 4 : 2} AS event_time, toJSONString(row.${group ? 5 : 3}) AS sets,
        toJSONString(row.${group ? 6 : 4}) AS increments
      FROM deduped
    ), entities AS (
      SELECT ${identity}, ${group ? "argMaxIf(group_name, tuple(event_time, event_id), group_name != '') AS name," : ""}
        min(event_time) AS first_seen, max(event_time) AS last_seen,
        arrayFold((values, mutation) -> highkey_apply_traits(values, mutation.3, mutation.4),
          arraySort(mutation -> (mutation.1, mutation.2), groupArray(tuple(event_time, event_id, sets, increments))),
          CAST(map(), 'Map(String, String)')) AS traits
      FROM records
      WHERE ({id:String} = '' OR ${id} = {id:String})
        ${group ? "AND ({type:String} = '' OR group_type = {type:String})" : ""}
      GROUP BY ${key}
    )
    SELECT *, count() OVER () AS total FROM entities
    WHERE {search:String} = '' OR positionCaseInsensitiveUTF8(concat(id, ${group ? "name," : ""} toJSONString(traits)), {search:String}) > 0
    ORDER BY last_seen DESC, ${key} LIMIT {size:UInt32} OFFSET {offset:UInt32}`,
    { params },
  );
  return {
    rows: result.data.map(({ total: _total, traits, ...row }) => ({
      ...row,
      traits: Object.fromEntries(
        Object.entries(traits).map(([key, value]) => [key, JSON.parse(value)]),
      ),
    })),
    total: Number(result.data[0]?.total ?? 0),
    page: q.page,
    page_size: q.page_size,
  };
}
