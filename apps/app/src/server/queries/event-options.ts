import { fields } from "../api/body";
import { bad } from "../api/errors";
import type { ApiContext } from "../api/context";
import { requireSource } from "../db/sources";
import { readAs } from "./read";
import { parseEventsQuery } from "./events";
import { runSettings } from "../clickhouse/access";
import { validKey } from "./properties";
export async function eventOptions(ctx: ApiContext, id: string, body: unknown) {
  const q = fields(body, {
    from: "string",
    to: "string",
    source_id: "string?",
    event: "string?",
    property: "string?",
  });
  const spec = parseEventsQuery({ from: q.from, to: q.to });
  if (q.source_id) await requireSource(ctx.db, id, q.source_id);
  if (q.property && !validKey(q.property)) throw bad("Invalid property");
  const opts = {
    settings: runSettings({
      from: spec.from,
      to: spec.to,
      source: q.source_id ?? null,
      bucket: "day",
    }),
    params: { event: q.event ?? "", key: q.property ?? "" },
  };
  return readAs(ctx, id, async (r) => {
    const names = (
      await r.query<{ name: string }>(
        "SELECT DISTINCT name FROM event_facets WHERE property='' ORDER BY name LIMIT 200",
        opts,
      )
    ).data.map((v) => v.name);
    const scope = "({event:String}='' OR name={event:String})";
    const keys = (
      await r.query<{ property: string }>(
        `SELECT DISTINCT property FROM event_facets WHERE ${scope} AND property!='' ORDER BY property LIMIT 200`,
        opts,
      )
    ).data.map((v) => v.property);
    const values = q.property
      ? (
          await r.query<{ v: string[] }>(
            `SELECT groupUniqArrayMerge(32)(samples) AS v FROM event_facets WHERE ${scope} AND property={key:String}`,
            opts,
          )
        ).data[0].v
          .filter(Boolean)
          .sort()
      : [];
    return { names, keys, values };
  });
}
