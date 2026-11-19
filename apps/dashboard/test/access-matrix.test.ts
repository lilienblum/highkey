import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { handleApi, registeredRoutes } from "../src/server/api/router";
import { visitorRequest } from "../src/server/api/serve";
import { can, type Role } from "../src/server/auth/roles";
import { joinAs, signUp, TEST_ORIGIN } from "./auth-helpers";
import { call, project, type TestContext, testContext } from "./helpers";

let ctx: TestContext;
let shop: { id: string; slug: string };
const as: Record<Role | "outsider" | "anonymous", Headers> = {} as never;

beforeAll(async () => {
  ctx = await testContext();
  const auth = await ctx.auth();
  // The context's own session is the owner (and, as the first account, the server admin).
  as.owner = ctx.session;
  as.admin = await joinAs(auth, ctx.session, "admin@example.com", "admin");
  as.member = await joinAs(auth, ctx.session, "member@example.com", "member");
  as.viewer = await joinAs(auth, ctx.session, "viewer@example.com", "viewer");
  as.outsider = await signUp(auth, "outsider@example.com");
  as.anonymous = new Headers();
  shop = await project(ctx, "Shop");
}, 300_000);
afterAll(() => ctx?.cleanup());

async function send(
  method: string,
  path: string,
  who: Headers,
  extra: Record<string, string> = {},
): Promise<number> {
  const headers = new Headers(who);
  headers.set("content-type", "application/json");
  // MCP refuses any Origin (browsers never call it); every other write comes from the dashboard.
  if (!path.endsWith("/mcp")) headers.set("origin", TEST_ORIGIN);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  const body = method === "GET" || method === "HEAD" ? undefined : "{}";
  const response = await handleApi(
    new Request(`${TEST_ORIGIN}${path}`, { method, headers, body }),
    ctx,
  );
  await response.arrayBuffer();
  return response.status;
}

function concrete(pattern: string): string {
  return pattern
    .replace(":id", shop.id)
    .replace(":project", shop.slug)
    .replace(/:(key|source)/g, "missing")
    .replace(":n", "1");
}

describe("access", () => {
  test("every_route_obeys_the_role_table", async () => {
    const routes = await registeredRoutes();
    expect(routes.length).toBeGreaterThan(30);
    for (const route of routes) {
      const path = concrete(route.pattern);
      const scoped = route.pattern.includes(":id") || route.pattern.includes(":project");
      // MCP takes agents' tokens and API keys, never a browser session (mcp-oauth tests).
      const agentsOnly = route.pattern.endsWith("/mcp");
      for (const role of ["owner", "admin", "member", "viewer"] as Role[]) {
        const status = await send(route.method, path, as[role]);
        if (agentsOnly) {
          expect({ route: route.pattern, role, status }).toEqual({
            route: route.pattern,
            role,
            status: 401,
          });
          continue;
        }
        const allowed = route.need === "server-admin" ? role === "owner" : can(role, route.need);
        expect({
          route: `${route.method} ${route.pattern}`,
          role,
          refused: status === 403,
        }).toEqual({ route: `${route.method} ${route.pattern}`, role, refused: !allowed });
        expect({ route: `${route.method} ${route.pattern}`, role, status }).not.toEqual({
          route: `${route.method} ${route.pattern}`,
          role,
          status: 401,
        });
      }
      // Another organization never sees this one's projects: they are simply not found.
      const outsider = await send(route.method, path, as.outsider);
      if (scoped)
        expect({ route: `${route.method} ${route.pattern}`, outsider }).toEqual({
          route: `${route.method} ${route.pattern}`,
          outsider: route.need === "server-admin" ? 403 : 404,
        });
      expect({
        route: `${route.method} ${route.pattern}`,
        anonymous: await send(route.method, path, as.anonymous),
      }).toEqual({
        route: `${route.method} ${route.pattern}`,
        anonymous: 401,
      });
    }
  }, 120_000);

  test("another_organization_lists_only_its_own_projects", async () => {
    const reply = await handleApi(
      new Request(`${TEST_ORIGIN}/api/products`, { headers: as.outsider }),
      ctx,
    );
    const listed = (await reply.json()) as { id: string }[];
    expect(listed.map((p) => p.id)).not.toContain(shop.id);
  });

  test("a_removed_member_is_refused_on_the_next_request", async () => {
    const auth = await ctx.auth();
    const leaving = await joinAs(auth, ctx.session, "leaving@example.com", "member");
    expect(await send("GET", `/api/products/${shop.id}/sources`, leaving)).toBe(200);
    await auth.api.removeMember({
      body: { memberIdOrEmail: "leaving@example.com" },
      headers: ctx.session,
    });
    expect(await send("GET", `/api/products/${shop.id}/sources`, leaving)).toBe(403);
  });

  test("a_demoted_member_loses_writes_at_once", async () => {
    const auth = await ctx.auth();
    const demoted = await joinAs(auth, ctx.session, "demoted@example.com", "member");
    const path = `/api/products/${shop.id}/sources`;
    expect(await send("POST", path, demoted)).not.toBe(403);
    const members = (await auth.api.listMembers({ headers: ctx.session })) as {
      members: { id: string; user: { email: string } }[];
    };
    const member = members.members.find((m) => m.user.email === "demoted@example.com");
    await auth.api.updateMemberRole({
      body: { memberId: member?.id as string, role: "viewer" },
      headers: ctx.session,
    });
    expect(await send("POST", path, demoted)).toBe(403);
  });

  test("a_foreign_host_is_refused", async () => {
    const response = await handleApi(
      new Request("http://attacker.example/api/products", { headers: as.owner }),
      ctx,
    );
    expect(response.status).toBe(421);
  });

  test("a_cross_site_write_is_refused", async () => {
    expect(
      await send("POST", `/api/products/${shop.id}/sources`, as.owner, {
        origin: "https://attacker.example",
      }),
    ).toBe(403);
  });

  test("moving_a_project_needs_admin_in_both_organizations", async () => {
    const auth = await ctx.auth();
    const as = (who: Headers) => ({ cookie: who.get("cookie") as string });
    const moving = await project(ctx, "Moving");
    const board = {
      version: 1,
      name: "Board",
      widgets: [
        {
          id: "views",
          title: "Page views",
          view: { type: "stat" },
          queries: { views: { signal: "events", event: "page_view", measure: "count" } },
          series: [{ expr: "views" }],
        },
      ],
    };
    const path = `/api/products/${moving.id}`;
    expect((await call(ctx, "POST", `${path}/dashboards`, { document: board })).status).toBe(200);
    expect((await call(ctx, "POST", `${path}/keys`, { label: "Web" })).status).toBe(200);
    // The target already has a project of that name, so the moved one takes the next slug there.
    const target = await signUp(auth, "target@example.com");
    const [org] = (await auth.api.listOrganizations({ headers: target })) as { id: string }[];
    const targetId = org?.id as string;
    const taken = { name: "Moving", retention_days: 30 };
    expect((await call(ctx, "POST", "/api/products", taken, as(target))).status).toBe(200);
    // The mover is an admin at home but only a member of the target.
    const mover = await joinAs(auth, ctx.session, "mover@example.com", "admin");
    const home = (await auth.api.getSession({ headers: mover }))?.session.activeOrganizationId;
    const move = () => call(ctx, "POST", `${path}/move`, { organization: targetId }, as(mover));
    expect((await move()).status).toBe(403);
    const invitation = (await auth.api.createInvitation({
      body: { email: "mover@example.com", role: "member", organizationId: targetId },
      headers: target,
    })) as { id: string };
    await auth.api.acceptInvitation({ body: { invitationId: invitation.id }, headers: mover });
    await auth.api.setActiveOrganization({ body: { organizationId: home }, headers: mover });
    expect((await move()).status).toBe(403);
    const members = (await auth.api.listMembers({
      query: { organizationId: targetId },
      headers: target,
    })) as { members: { id: string; user: { email: string } }[] };
    const member = members.members.find((m) => m.user.email === "mover@example.com");
    await auth.api.updateMemberRole({
      body: { memberId: member?.id as string, role: "admin", organizationId: targetId },
      headers: target,
    });
    const moved = await move();
    expect(moved.status).toBe(200);
    expect(moved.json).toMatchObject({ id: moving.id, slug: "moving-2" });
    // The old organization no longer finds it; the new one has its dashboards and keys.
    expect((await call(ctx, "GET", `${path}/keys`)).status).toBe(404);
    const boards = await call(ctx, "GET", `/api/read/products/moving-2/dashboards`, undefined, {
      ...as(target),
    });
    expect(boards.json.map((d: { name: string }) => d.name)).toEqual(["Board"]);
    const keys = await call(ctx, "GET", `${path}/keys`, undefined, as(target));
    expect(keys.json.map((k: { label: string }) => k.label)).toEqual(["Web"]);
  });

  test("a_server_render_carries_the_visitors_session", async () => {
    const signedIn = new Request(`${TEST_ORIGIN}/`, { headers: ctx.session });
    expect((await handleApi(visitorRequest(signedIn, "/api/products"), ctx)).status).toBe(200);
    const anonymous = new Request(`${TEST_ORIGIN}/`);
    expect((await handleApi(visitorRequest(anonymous, "/api/products"), ctx)).status).toBe(401);
  });
});
