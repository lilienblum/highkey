import { tako } from "tako.sh";
import { fields, readJson } from "./api/body";
import { bad, json } from "./api/errors";
import type { ApiContext } from "./api/context";
import { route, READ } from "./api/router";
import { requireSource } from "./db/sources";
import { readAs } from "./queries/read";
import { runSettings } from "./clickhouse/access";
import { eventContext } from "../lib/event-context";
import { DAY_MS, periodLabels, presetRange, type DatePeriod } from "../lib/date-range";
import { predicate, parseEventsQuery } from "./queries/events";
import { Params } from "./queries/properties";
import { throttle } from "./dashboards/routes";
const allowed = [
  "name",
  "source",
  "property:path",
  "property:utm_source",
  "property:utm_medium",
  "property:utm_campaign",
  "property:command",
  "property:version",
  ...Object.keys(eventContext)
    .filter((k) => k !== "bot")
    .map((k) => `property:context.${k}`),
];
const periods = ["keep", "7d", "30d", "90d", ...Object.keys(periodLabels)];
type Proposal = { period: string; field: string; value: string };
// Common device shortcuts require neither a provider account nor a network call.
function shortcut(text: string): Proposal | undefined {
  const m =
    /^(?:(last (7|30|90) days|today|yesterday)\s*(?:,\s*|\s+))?(mobile|desktop|tablet)(?: only)?$/i.exec(
      text,
    );
  if (m)
    return {
      period: m[2] ? m[2] + "d" : (m[1]?.toLowerCase() ?? "keep"),
      field: "property:context.device",
      value: m[3][0].toUpperCase() + m[3].slice(1).toLowerCase(),
    };
}
async function model(text: string) {
  const secret = (k: string) =>
      (tako.secrets as Record<string, string | undefined>)[k] ?? process.env[k],
    key = secret("HIGHKEY_FILTER_MODEL_KEY");
  if (!key)
    throw bad(
      "Try “last 7 days, mobile only” or configure HIGHKEY_FILTER_MODEL_KEY for other phrases",
    );
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(8000),
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: secret("HIGHKEY_FILTER_MODEL") ?? "gpt-4o-mini",
      store: false,
      max_completion_tokens: 180,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Translate a report request into JSON with string keys period,field,value. Period must be one of ${periods.join(", ")}; keep if unspecified. Field must be one of ${allowed.join(", ")}; empty field and value for a date-only change. Device values: Mobile, Desktop, Tablet, TV. Return {} for unsupported requests. Do not invent values.`,
        },
        { role: "user", content: text },
      ],
    }),
  });
  if (!response.ok)
    throw bad("The filter model is unavailable; try again or use the report controls");
  try {
    return JSON.parse((await response.json()).choices[0].message.content);
  } catch {
    throw bad("The filter model did not return a usable change");
  }
}
export async function languageFilter(
  ctx: ApiContext,
  id: string,
  body: unknown,
  interpret: (text: string) => Promise<unknown> = model,
) {
  const q = fields(body, { text: "string", from: "string", to: "string", source_id: "string?" }),
    text = q.text.trim();
  if (!text || text.length > 320) throw bad("Describe the filter in 1–320 characters");
  if (q.source_id) await requireSource(ctx.db, id, q.source_id);
  const current = parseEventsQuery({ from: q.from, to: q.to });
  throttle(ctx, id);
  const result = fields(shortcut(text) ?? (await interpret(text)), {
    period: "string",
    field: "string",
    value: "string",
  });
  if (
    !periods.includes(result.period) ||
    (result.field
      ? !allowed.includes(result.field) || !result.value || result.value.length > 512
      : result.value !== "" || result.period === "keep")
  )
    throw bad("That phrase does not describe a supported filter change");
  const days = result.period.endsWith("d") ? Number.parseInt(result.period) : undefined,
    now = +ctx.now();
  const range =
    result.period === "keep"
      ? { from: current.from.toISOString(), to: current.to.toISOString() }
      : days
        ? { from: new Date(now - days * DAY_MS).toISOString(), to: new Date(now).toISOString() }
        : presetRange(result.period as DatePeriod, now);
  if (result.field) {
    const p = new Params(),
      where = predicate(
        parseEventsQuery({
          ...range,
          ...(result.field === "name"
            ? { names: [result.value] }
            : result.field === "source"
              ? { source: result.value }
              : { filters: [{ property: result.field.slice(9), op: "eq", value: result.value }] }),
        }),
        p,
      );
    const match = await readAs(ctx, id, (r) =>
      r.query(`SELECT 1 FROM events WHERE ${where} LIMIT 1`, {
        params: p.values,
        settings: runSettings({
          from: new Date(range.from),
          to: new Date(range.to),
          source: q.source_id ?? null,
          bucket: "day",
        }),
      }),
    );
    if (!match.rows) throw bad("No matching value was observed for this source and period");
  }
  return {
    period: result.period,
    filter: result.field ? { field: result.field, value: result.value } : null,
  };
}
export function registerLanguageFilter() {
  route("POST", "/api/products/:project/language-filter", READ, async (req, ctx, { project }) =>
    json(await languageFilter(ctx, project!, await readJson(req))),
  );
}
