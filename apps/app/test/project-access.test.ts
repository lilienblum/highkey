import { expect, test } from "bun:test";
import { call, project, testContext } from "./helpers";
import { joinAs } from "./auth-helpers";
test("member grants apply to sessions and existing credentials; project keys cannot manage the organization", async () => {
  const ctx = await testContext();
  try {
    const a = await project(ctx, "Left"),
      b = await project(ctx, "Right");
    const auth = await ctx.auth(),
      user = await joinAs(auth, ctx.session, "limited@example.test", "member");
    const member = (await auth.api.listMembers({ headers: ctx.session })).members.find(
      (m) => m.user.email === "limited@example.test",
    )!;
    const who = { cookie: user.get("cookie")! };
    const token = async (project_id?: string) =>
      (await call(ctx, "POST", "/api/keys", { name: "Tool", access: "write", project_id }, who))
        .json.key as string;
    const as = (key: string) => ({ cookie: "", origin: "", authorization: `Bearer ${key}` });
    const full = as(await token()),
      specific = as(await token(a.id));
    const list = async (h: Record<string, string>) =>
      (await call(ctx, "GET", "/api/products", undefined, h)).json.map((r: { id: string }) => r.id);
    expect(await list(specific)).toEqual([a.id]);
    expect(
      (await call(ctx, "GET", `/api/read/products/${b.slug}/catalog`, undefined, specific)).status,
    ).toBe(404);
    expect((await call(ctx, "GET", "/api/keys", undefined, specific)).status).toBe(403);
    const doc = { version: 1, name: "Test", widgets: [] };
    expect(
      (await call(ctx, "POST", `/api/products/${a.id}/dashboards`, { document: doc }, specific))
        .status,
    ).toBe(200);
    expect(
      (await call(ctx, "POST", `/api/products/${a.id}/sources`, { name: "No" }, specific)).status,
    ).toBe(403);
    const path = `/api/members/${member.id}/projects`;
    const set = (projects: { id: string; access: string }[]) =>
      call(ctx, "PUT", path, { mode: "selected", projects });
    expect((await set([{ id: b.id, access: "read" }])).status).toBe(204);
    const c = await project(ctx, "Later");
    expect(await list(who)).toEqual([b.id]);
    expect(await list(full)).toEqual([b.id]);
    expect(await list(specific)).toEqual([]);
    expect(
      (await call(ctx, "GET", `/api/read/products/${c.id}/catalog`, undefined, who)).status,
    ).toBe(404);
    expect(
      (await call(ctx, "POST", `/api/products/${b.id}/sources`, { name: "No" }, full)).status,
    ).toBe(403);
    const rpc = async (h: Record<string, string>, name: string, args: object) =>
      (
        await call(
          ctx,
          "POST",
          "/api/mcp",
          { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
          h,
        )
      ).json.result;
    expect((await rpc(full, "create_source", { project: b.id, name: "No" })).isError).toBe(true);
    expect((await rpc(full, "describe_project", { project: a.slug })).isError).toBe(true);
    expect((await rpc(full, "describe_project", { project: b.slug })).isError).toBe(false);
    expect((await rpc(specific, "create_project", { name: "No" })).isError).toBe(true);
    await set([{ id: a.id, access: "write" }]);
    expect(
      (await call(ctx, "POST", `/api/products/${a.id}/sources`, { name: "Yes" }, full)).status,
    ).toBe(200);
    expect((await call(ctx, "PUT", path, { mode: "all" }, who)).status).toBe(403);
    await call(ctx, "PUT", path, { mode: "all" });
    expect(await list(full)).toContain(c.id);
  } finally {
    ctx.cleanup();
  }
}, 30000);
