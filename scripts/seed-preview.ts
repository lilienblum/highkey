// Local operator command: tako -c tako.app.toml run --env development scripts/seed-preview.ts <org-slug>
import { apiContext } from "../apps/app/src/server/api/context";
import { ensureProjectAccess, runSettings } from "../apps/app/src/server/clickhouse/access";
import { one } from "../apps/app/src/server/db/db";
import { takoDatabase } from "../apps/app/src/server/db/open";
import { product, saveProduct } from "../apps/app/src/server/db/products";
import {
  createEventKey,
  createProjectLogKey,
  createSource,
  revokeEventKey,
  revokeProjectLogKey,
  updateSource,
} from "../apps/app/src/server/operations";
import { createFor as createView } from "../apps/app/src/server/views";
import {
  createFor as createDashboard,
  registerDashboards,
} from "../apps/app/src/server/dashboards/routes";
import { saveEventDefinition } from "../apps/app/src/server/event-catalog";
import { nightlyProject } from "../apps/app/src/server/insights";
import { listCohorts, refreshCohort, type CohortDefinition } from "../apps/app/src/server/cohorts";
import { previewData, sources } from "./preview-data";

const slug = process.argv[2],
  ctx = apiContext(),
  ingest = process.env.HIGHKEY_INGEST_URL;
if (
  !slug ||
  ctx.publicUrl !== "https://highkey.test" ||
  ingest !== "https://highkey-ingest.test" ||
  !takoDatabase()
) {
  throw new Error(
    "Run from local development: tako -c tako.app.toml run --env development scripts/seed-preview.ts <organization-slug>",
  );
}
async function send(
  path: string,
  field: "events" | "logs",
  records: unknown[],
  key: string,
  agent: string,
) {
  for (let i = 0; i < records.length; i += 100) {
    const batch = records.slice(i, i + 100);
    const response = await fetch(`${ingest}${path}`, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        "user-agent": agent,
      },
      body: JSON.stringify({ [field]: batch }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new Error(`Seed ${field}: HTTP ${response.status}: ${await response.text()}`);
    const ack = (await response.json()) as { accepted: number; duplicates: number };
    if (ack.accepted + ack.duplicates !== batch.length)
      throw new Error(`Incomplete ${field} acknowledgment`);
  }
}
try {
  const org = await one<{ id: string }>(ctx.db, "SELECT id FROM organization WHERE slug=?", [slug]);
  if (!org) throw new Error(`No local organization named ${slug}`);
  // Remember this particular fixture by ID. An existing project with the same display name is never reused.
  const project = await ctx.db.transaction(async (tx) => {
    const key = `seed:fieldwork-preview:v1:${org.id}`;
    const previous = await one<{ id: string }>(
      tx,
      "SELECT p.id FROM products p JOIN settings s ON s.value=p.id WHERE s.key=? AND p.org_id=? AND p.deleted_at IS NULL",
      [key, org.id],
    );
    if (previous) return product(tx, previous.id);
    const created = await saveProduct(
      tx,
      null,
      { name: "Fieldwork Demo", retention_days: 90 },
      org.id,
    );
    await tx.execute(
      "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [key, created.id],
    );
    return created;
  });
  const id = project.id;
  console.log(`Seeding ${ctx.publicUrl}/${slug}/${project.slug}`);
  await ensureProjectAccess(ctx.admin, id, ctx.secret);
  const data = previewData(Date.now(), Date.parse(project.created_at));
  for (const name of sources) {
    const input = {
      name,
      icon: name === "Website" ? "website" : name === "CLI" ? "terminal" : "ios",
    } as const;
    const source =
      project.sources.find((s) => s.name === name) ??
      (name === "Website" && project.sources.some((s) => s.id === id && s.name === "Events")
        ? await updateSource(ctx, id, id, input)
        : await createSource(ctx, id, input));
    const credential = await createEventKey(ctx, id, "Preview seed", source.id, [], "server");
    try {
      await send(
        "/api/ingest",
        "events",
        data.events[name],
        credential.key,
        name === "CLI"
          ? "FieldworkCLI/2.8"
          : name === "Website"
            ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36"
            : "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 Version/17.2 Mobile Safari/604.1",
      );
    } finally {
      await revokeEventKey(ctx, id, credential.id);
    }
    const logs = data.logs.filter(
      (l) =>
        l.attributes.client === (name === "CLI" ? "cli" : name === "Website" ? "browser" : "ios"),
    );
    const logKey = await createProjectLogKey(ctx, id, "Preview seed", source.id);
    try {
      await send("/api/logs/ingest", "logs", logs, logKey.key, "FieldworkLogger/2.8");
    } finally {
      await revokeProjectLogKey(ctx, id, logKey.id);
    }
    console.log(
      `${name}: confirmed ${data.events[name].length} event records and ${logs.length} logs`,
    );
  }
  for (const doc of [
    {
      version: 1,
      kind: "events",
      name: "New signups",
      query: { measure: "count", event: "signup_completed" },
    },
    {
      version: 1,
      kind: "logs",
      name: "Errors and warnings",
      query: { min_level: "warn" },
      window: "24h",
    },
  ])
    if (!project.views.some((v) => v.name === doc.name && v.kind === doc.kind))
      await createView(ctx, id, doc);
  await saveEventDefinition(ctx, id, {
    name: "signup_completed",
    conversion: true,
    description: "A visitor finished creating a Fieldwork account.",
  });
  if (!project.dashboards.some((d) => d.name === "Release pulse")) {
    registerDashboards(); // Use the same pre-save widget benchmarks as the dashboard API.
    await createDashboard(
      ctx,
      id,
      {
        version: 1,
        name: "Release pulse",
        widgets: [
          {
            id: "signups",
            title: "New signups",
            view: { type: "stat", sparkline: true, compare: "previous_period" },
            queries: { q: { signal: "events", event: "signup_completed" } },
          },
          {
            id: "commands",
            title: "CLI activity",
            view: { type: "line" },
            queries: { q: { signal: "events", event: "command_run" } },
          },
          {
            id: "pages",
            title: "Popular pages",
            view: { type: "ranking", limit: 6 },
            queries: { q: { signal: "events", event: "page_view", group_by: "property:path" } },
          },
          {
            id: "errors",
            title: "Recent errors",
            view: { type: "logs", limit: 8 },
            queries: { q: { signal: "logs", min_level: "error" } },
          },
        ],
      },
      "api",
    );
  }
  const cohortName = "Repeat CLI users";
  const definition: CohortDefinition = {
    mode: "dynamic",
    match: "all",
    rules: [{ event: "command_run", days: 7, compare: "at_least", count: 2 }],
  };
  // Let the regular cohort evaluator compute membership from the ingested events.
  await ctx.db.execute(
    "INSERT INTO cohorts(id,product_id,name,definition,revision) VALUES(?,?,?,?,1) ON CONFLICT(product_id,name) DO NOTHING",
    [crypto.randomUUID(), id, cohortName, JSON.stringify(definition)],
  );
  const cohort = (await listCohorts(ctx, id)).find((c) => c.name === cohortName)!;
  await refreshCohort(ctx, id, cohort);
  await nightlyProject(ctx, id);
  const settings = runSettings({
    from: new Date(Date.now() - 30 * 86400000),
    to: new Date(),
    bucket: "day",
    source: null,
  });
  const reader = ctx.readers.reader(id);
  const result = await reader.query(
    "SELECT count() AS events, uniqExact(profile_id) AS profiles, uniqExactIf(session_id,session_id IS NOT NULL) AS visits, countIf(name='ai_generation') AS generations, sum(properties.revenue.:Int64) AS net_cents FROM events",
    { settings },
  );
  console.log("Verified through the project's reader:", result.data[0]);
  console.log(`Open ${ctx.publicUrl}/${slug}/${project.slug}`);
} finally {
  await ctx.db.close();
}
