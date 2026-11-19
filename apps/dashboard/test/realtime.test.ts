// Live hints go to one stream per organization: a change reaches only the organization that owns
// the project, and only that organization's members may subscribe to its stream.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChangeEnvelope } from "../src/lib/change-envelope";
import { routeChanges, sessionCookieName, verifyChannel } from "../src/server/realtime";
import { signUp, TEST_ORIGIN } from "./auth-helpers";
import { call, project, type TestContext, testContext } from "./helpers";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await testContext();
}, 300_000);
afterEach(() => ctx?.cleanup());

async function orgOf(who: Headers): Promise<string> {
  const session = await (await ctx.auth()).api.getSession({ headers: who });
  return session?.session.activeOrganizationId as string;
}

/** The session cookie's value, as tako-server hands it to the channel's verify. */
function sessionCookie(who: Headers): string {
  const name = sessionCookieName(TEST_ORIGIN);
  const pair = (who.get("cookie") as string)
    .split("; ")
    .find((part) => part.startsWith(`${name}=`));
  return pair?.slice(name.length + 1) as string;
}

describe("live hints", () => {
  test("hints_reach_only_the_owning_organization", async () => {
    const auth = await ctx.auth();
    const shop = await project(ctx, "Shop");
    const other = await signUp(auth, "other@example.com");
    const elsewhere = (
      await call(
        ctx,
        "POST",
        "/api/products",
        { name: "Elsewhere", retention_days: 30 },
        {
          cookie: other.get("cookie") as string,
        },
      )
    ).json as { id: string };
    const published: { org: string; envelope: ChangeEnvelope }[] = [];
    const publish = async (org: string, envelope: ChangeEnvelope) => {
      published.push({ org, envelope });
    };
    await routeChanges(
      ctx.db,
      {
        version: 2,
        changes: [
          { product: shop.id, signals: ["events"] },
          { product: elsewhere.id, signals: ["logs", "dashboards"] },
          { product: crypto.randomUUID(), signals: ["events"] },
        ],
      },
      publish,
    );
    const byOrg = Object.fromEntries(published.map((p) => [p.org, p.envelope.changes]));
    expect(byOrg).toEqual({
      [await orgOf(ctx.session)]: [{ product: shop.id, signals: ["events"] }],
      [await orgOf(other)]: [{ product: elsewhere.id, signals: ["logs", "dashboards"] }],
    });
    // A full resync from the ingest app reaches every organization that has projects.
    published.length = 0;
    await routeChanges(ctx.db, { version: 2, changes: null }, publish);
    expect(published.map((p) => p.org).sort()).toEqual(
      [await orgOf(ctx.session), await orgOf(other)].sort(),
    );
    expect(published.every((p) => p.envelope.changes === null)).toBe(true);
    // A change for a project no organization owns any more is dropped.
    published.length = 0;
    await routeChanges(
      ctx.db,
      { version: 2, changes: [{ product: crypto.randomUUID(), signals: ["events"] }] },
      publish,
    );
    expect(published).toEqual([]);
  });

  test("a_non_member_subscription_is_refused", async () => {
    const auth = await ctx.auth();
    const org = await orgOf(ctx.session);
    expect(ctx.session.get("cookie")).toContain(`${sessionCookieName(TEST_ORIGIN)}=`);
    const member = await verifyChannel(ctx, {
      params: { org },
      cookie: sessionCookie(ctx.session),
    });
    expect(member).toMatchObject({ subject: expect.any(String) });
    const outsider = await signUp(auth, "outsider@example.com");
    expect(await verifyChannel(ctx, { params: { org }, cookie: sessionCookie(outsider) })).toBe(
      false,
    );
    expect(await verifyChannel(ctx, { params: { org } })).toBe(false);
    expect(await verifyChannel(ctx, { params: { org }, cookie: "forged.value" })).toBe(false);
    expect(sessionCookieName("http://127.0.0.1:3000")).toBe("better-auth.session_token");
  });
});
