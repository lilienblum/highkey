import { expect, test } from "bun:test";
import { call, project, testContext, seedEvents } from "./helpers";
test("chart references merge manual notes, deploys and only the earliest known CLI version in the project", async () => {
  const ctx = await testContext();
  try {
    const p = await project(ctx),
      t = Date.now() - 60000;
    const start = new Date(t).toISOString(),
      range = { from: start, to: new Date(t + 60000).toISOString() };
    const path = `/api/products/${p.id}/references`;
    const created = await call(ctx, "POST", path, {
      title: " Release ",
      description: "Trial pricing",
      at: start,
    });
    expect(created.status).toBe(200);
    const row = (v: string, id: string, offset: number) => ({
      event_id: id,
      time: new Date(t + offset),
      name: "command_run",
      source: "cli",
      properties: { version: v },
    });
    await seedEvents(p.id, [
      row("1.0", "old", -1000),
      row("1.0", "again", 3000),
      row("2.0", "first", 1000),
      row("2.0", "second", 2000),
      { event_id: "ship", name: "deploy", time: new Date(t + 3000) },
    ]);
    const found = await call(ctx, "POST", path + "/query", range);
    expect(found.json.rows.map((r: { title: string; at: number }) => [r.title, r.at])).toEqual([
      ["Deployment", t + 3000],
      ["CLI 2.0", t + 1000],
      ["Release", t],
    ]);
    const other = await project(ctx, "Another");
    expect(
      (await call(ctx, "DELETE", `/api/products/${other.id}/references/${created.json.id}`)).status,
    ).toBe(404);
    expect((await call(ctx, "DELETE", path + "/" + created.json.id)).status).toBe(204);
    expect((await call(ctx, "POST", path, { title: "", at: start })).status).toBe(400);
  } finally {
    ctx.cleanup();
  }
}, 30000);
