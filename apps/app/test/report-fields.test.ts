import { expect, test } from "bun:test";
import { call, project, testContext, seedEvents } from "./helpers";
import { languageFilter } from "../src/server/language-filter";
import { runWidget } from "../src/server/dashboards/run";
test("map measures and entity filters count typed memberships and whole visits", async () => {
  const ctx = await testContext();
  try {
    const p = await project(ctx),
      now = Date.now(),
      base = now - 90000,
      stamp = new Date(base).toISOString().slice(0, 19).replace("T", " ");
    const record = {
      product_id: p.id,
      source_id: p.id,
      source: "cli",
      name: "declare",
      event_time: stamp,
      received_at: stamp,
      expires_at: "2030-01-01 00:00:00",
      properties: {},
    };
    await ctx.admin.insert("highkey.events", [
      {
        ...record,
        event_id: "identify",
        record_type: "identify",
        profile_id: "a",
        traits: { plan: "pro" },
      },
      {
        ...record,
        event_id: "group",
        record_type: "group",
        group_type: "team",
        group_id: "g",
        traits: { size: 5 },
      },
    ]);
    await seedEvents(
      p.id,
      [0, 1, 2, 3].map((i) => ({
        event_id: `e${i}`,
        time: new Date(base + i * 1000),
        identity_kind: "visitor",
        actor_id: i === 3 ? null : "v",
        session_id: i === 3 ? null : "s",
        profile_id: i === 3 ? null : "a",
        groups: i === 3 ? undefined : { team: "g", org: "g" },
        properties: { path: `/${i}` },
      })),
    );
    const range = { from: new Date(base + 500).toISOString(), to: new Date(now).toISOString() };
    const query = async (extra: object) => {
      const r = await call(ctx, "POST", `/api/products/${p.id}/query`, { ...range, ...extra });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      return r.json;
    };
    const people = async (path: string) =>
      (
        await call(ctx, "POST", `/api/products/${p.id}/people/query`, {
          ...range,
          audience: JSON.stringify([{ filters: [{ property: "path", op: "eq", value: path }] }]),
        })
      ).json.rows;
    expect((await people("/1")).map((v: { id: string }) => v.id)).toEqual(["a"]);
    expect(await people("/3")).toEqual([]);
    for (const [property, op, value, total] of [
      ["profile.plan", "eq", "pro", 2],
      ["group.team.size", "gt", 3, 2],
      ["session.entry_page", "eq", "/0", 2],
      ["profile.plan", "empty", undefined, 1],
      ["group.team.size", "eq", "5", 0],
      ["page.exit", "eq", "/2", 1],
    ])
      expect((await query({ filters: [{ property, op, value }] })).summary.total).toBe(total);
    for (const [measure, n] of [
      ["unique_groups", 2],
      ["first_time", 0],
      ["once_per_user", 1],
    ])
      expect((await query({ measure })).summary.value).toBe(n);
    const m = await runWidget(ctx, p.id, {
      ...range,
      widget: {
        id: "geo",
        title: "Groups by country",
        view: { type: "map" },
        queries: {
          g: { signal: "events", measure: "unique_groups", group_by: "property:context.country" },
        },
      },
    });
    expect(m.series[0].groups).toEqual([{ label: null, value: 2 }]);
    expect(
      await languageFilter(ctx, p.id, { ...range, text: "last week for page views" }, async () => ({
        period: "7d",
        field: "name",
        value: "page_view",
      })),
    ).toEqual({ period: "7d", filter: { field: "name", value: "page_view" } });
    await expect(
      languageFilter(ctx, p.id, { ...range, text: "missing" }, async () => ({
        period: "keep",
        field: "property:path",
        value: "/unknown",
      })),
    ).rejects.toThrow("No matching value");
  } finally {
    ctx.cleanup();
  }
}, 30000);

test("the profile directory finds retained activity beyond report ranges", async () => {
  const ctx = await testContext();
  try {
    const p = await project(ctx, "Long-lived directory", 730);
    const day = 86_400_000,
      now = Date.now();
    await seedEvents(p.id, [
      { event_id: "old-person", time: new Date(now - 400 * day), profile_id: "ada" },
      {
        event_id: "old-visitor",
        time: new Date(now - 12 * day),
        identity_kind: "visitor",
        actor_id: "visitor",
      },
    ]);
    const list = (body: object) => call(ctx, "POST", `/api/products/${p.id}/people/query`, body);
    expect((await list({ search: "ada" })).json.rows).toMatchObject([{ id: "ada", events: 1 }]);
    expect((await list({ kind: "anonymous" })).json.rows).toMatchObject([{ id: "visitor" }]);
    expect((await list({ kind: "power" })).json.rows).toEqual([]);
    const to = new Date(now).toISOString();
    expect((await list({ from: new Date(now - 7 * day).toISOString(), to })).json.rows).toEqual([]);
    expect((await list({ to })).status).toBe(422);
    expect((await list({ audience: "[]" })).status).toBe(422);
  } finally {
    ctx.cleanup();
  }
});
