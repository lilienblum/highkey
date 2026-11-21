import { fields, readJson } from "./api/body";
import type { ApiContext } from "./api/context";
import { bad, json, noContent } from "./api/errors";
import { route, READ } from "./api/router";
import { all, one } from "./db/db";
import { sourceIcons } from "../lib/source-icons";
import { eventColors, type EventDefinition } from "../lib/event-catalog";
import { parseRules, validEvent } from "./queries/custom";
export async function eventDefinitions(ctx: ApiContext, id: string): Promise<EventDefinition[]> {
  const rows = await all<
    Omit<EventDefinition, "conversion" | "rules"> & { conversion: number; rules: string }
  >(
    ctx.db,
    "SELECT name,icon,color,description,sentence,conversion,rules FROM event_catalog WHERE product_id=? ORDER BY name",
    [id],
  );
  return rows.map(({ rules, ...r }) => ({
    ...r,
    conversion: !!r.conversion,
    ...(rules === "[]" ? {} : { rules: JSON.parse(rules) }),
  }));
}
export async function saveEventDefinition(ctx: ApiContext, id: string, body: unknown) {
  const q = fields(
    body,
    {
      name: "string",
      icon: "string",
      color: "string",
      description: "string",
      sentence: "string",
      conversion: "boolean",
      rules: "unknown",
    },
    { icon: "generic", color: "neutral", description: "", sentence: "", conversion: false },
  );
  const rules = parseRules(q.rules ?? []);
  if (q.name.startsWith("@") !== !!rules.length)
    throw bad("Custom events use @name and at least one alternative");
  if (
    !validEvent(q.name) ||
    !sourceIcons.some(([id]) => id === q.icon) ||
    !eventColors.some((v) => v === q.color) ||
    q.description.length > 512 ||
    q.sentence.length > 256
  )
    throw bad(
      "Use a valid event name, supported icon and color, a description ≤512 characters and a sentence ≤256 characters",
    );
  await ctx.db.transaction(async (tx) => {
    const count = await one<{ n: number }>(
      tx,
      "SELECT count(*) AS n FROM event_catalog WHERE product_id=? AND name!=?",
      [id, q.name],
    );
    if (Number(count?.n) >= 500) throw bad("The event catalog holds at most 500 definitions");
    await tx.execute(
      `INSERT INTO event_catalog(product_id,name,icon,color,description,sentence,conversion,rules) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(product_id,name) DO UPDATE SET icon=excluded.icon,color=excluded.color,description=excluded.description,sentence=excluded.sentence,conversion=excluded.conversion,rules=excluded.rules`,
      [
        id,
        q.name,
        q.icon,
        q.color,
        q.description,
        q.sentence,
        Number(q.conversion),
        JSON.stringify(rules),
      ],
    );
  });
  ctx.changes.notify(id, "dashboards");
  ctx.changes.notify(id, "events");
  return q;
}
export async function deleteEventDefinition(ctx: ApiContext, id: string, name: string) {
  if (!validEvent(name)) throw bad("Invalid event name");
  await ctx.db.execute("DELETE FROM event_catalog WHERE product_id=? AND name=?", [id, name]);
  ctx.changes.notify(id, "dashboards");
  ctx.changes.notify(id, "events");
}
export function registerEventCatalog() {
  for (const prefix of ["/api/products/:project", "/api/read/products/:project"])
    route("GET", `${prefix}/event-catalog`, READ, async (_r, ctx, { project }) =>
      json(await eventDefinitions(ctx, project as string)),
    );
  route(
    "PUT",
    "/api/products/:project/event-catalog",
    { dashboard: ["write"] },
    async (r, ctx, { project }) =>
      json(await saveEventDefinition(ctx, project as string, await readJson(r))),
  );
  route(
    "DELETE",
    "/api/products/:project/event-catalog",
    { dashboard: ["write"] },
    async (r, ctx, { project }) => {
      const q = fields(await readJson(r), { name: "string" });
      await deleteEventDefinition(ctx, project as string, q.name);
      return noContent();
    },
  );
}
