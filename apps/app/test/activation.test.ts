import { expect, test } from "bun:test";
import { call, project, testContext, seedEvents } from "./helpers";
import { checkSite } from "../src/server/website";
test("activation reports only the selected source's first received event and each project's milestones", async () => {
  const ctx = await testContext();
  try {
    const p = await project(ctx),
      other = await project(ctx);
    const src = (await call(ctx, "POST", `/api/products/${p.id}/sources`, { name: "Site" })).json
      .id;
    const state = async (id: string, source?: string) =>
      (
        await call(
          ctx,
          "GET",
          `/api/products/${id}/activation${source ? `?source_id=${source}` : ""}`,
        )
      ).json;
    expect(await state(p.id, src)).toEqual({
      first_event: null,
      mcp: false,
      dashboard: false,
      invited: false,
    });
    await seedEvents(p.id, [{ event_id: "a", name: "other_source" }]);
    expect((await state(p.id, src)).first_event).toBeNull();
    await seedEvents(p.id, [{ event_id: "first", source_id: src, name: "setup_check" }]);
    expect((await state(p.id, src)).first_event).toMatchObject({ name: "setup_check", sdk: "" });
    await ctx.db.execute("INSERT INTO project_mcp_connections VALUES (?)", [p.id]);
    expect((await state(other.id)).mcp).toBe(false);
    expect((await state(p.id)).mcp).toBe(true);
    expect(await checkSite("http://127.0.0.1")).toEqual({ status: "unavailable" });
  } finally {
    ctx.cleanup();
  }
}, 30000);
