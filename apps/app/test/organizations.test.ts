import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Auth } from "../src/server/auth/auth";
import { can, type Permission, type Role } from "../src/server/auth/roles";
import { saveProduct } from "../src/server/db/products";
import { authRequest, cookieFrom, testAuth } from "./auth-helpers";
import { type TestContext, testContext } from "./helpers";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await testContext({ signedIn: false });
}, 300_000);
afterEach(() => ctx?.cleanup());

async function signUp(auth: Auth, email: string, name = email.split("@")[0] as string) {
  const response = await authRequest(auth, "/sign-up/email", {
    email,
    password: "a password long enough",
    name,
  });
  return { response, headers: response.ok ? cookieFrom(response) : new Headers() };
}

async function organizations(auth: Auth, headers: Headers) {
  return (await auth.api.listOrganizations({ headers })) as { id: string; slug: string }[];
}

async function invite(auth: Auth, owner: Headers, email: string, role: Role = "member") {
  const [org] = await organizations(auth, owner);
  const invitation = (await auth.api.createInvitation({
    body: { email, role, organizationId: org?.id },
    headers: owner,
  })) as { id: string };
  return { org: org as { id: string; slug: string }, invitation };
}

describe("organizations", () => {
  test("signing_up_creates_an_owned_organization", async () => {
    const auth = testAuth(ctx);
    const { headers } = await signUp(auth, "ada@example.com", "Ada");
    const orgs = await organizations(auth, headers);
    expect(orgs).toHaveLength(1);
    const member = (await auth.api.getActiveMember({ headers })) as { role: string } | null;
    expect(member?.role).toBe("owner");
    const session = await auth.api.getSession({ headers });
    expect(session?.session.activeOrganizationId).toBe(orgs[0]?.id);
  });

  test("invite_mode_refuses_strangers_but_admits_the_first_account_and_invitees", async () => {
    const auth = testAuth(ctx, { signup: "invite" });
    const first = await signUp(auth, "owner@example.com");
    expect(first.response.status).toBe(200);
    const session = await auth.api.getSession({ headers: first.headers });
    expect((session?.user as { role?: string } | undefined)?.role).toBe("admin");
    const stranger = await signUp(auth, "stranger@example.com");
    expect(stranger.response.status).toBe(403);
    expect(await stranger.response.text()).toContain("by invitation");
    await invite(auth, first.headers, "guest@example.com");
    expect((await signUp(auth, "guest@example.com")).response.status).toBe(200);
  });

  test("open_mode_admits_anyone", async () => {
    const auth = testAuth(ctx, { signup: "open" });
    expect((await signUp(auth, "one@example.com")).response.status).toBe(200);
    const second = await signUp(auth, "two@example.com");
    expect(second.response.status).toBe(200);
    const session = await auth.api.getSession({ headers: second.headers });
    expect((session?.user as { role?: string } | undefined)?.role).not.toBe("admin");
  });

  test("an_invited_new_person_joins_only_the_inviting_organization", async () => {
    const auth = testAuth(ctx, { signup: "invite" });
    const owner = await signUp(auth, "owner@example.com");
    const { org, invitation } = await invite(auth, owner.headers, "new@example.com", "viewer");
    const invitee = await signUp(auth, "new@example.com");
    expect(await organizations(auth, invitee.headers)).toHaveLength(0);
    await auth.api.acceptInvitation({
      body: { invitationId: invitation.id },
      headers: invitee.headers,
    });
    const orgs = await organizations(auth, invitee.headers);
    expect(orgs.map((o) => o.id)).toEqual([org.id]);
    const member = (await auth.api.getActiveMember({ headers: invitee.headers })) as {
      role: string;
    } | null;
    expect(member?.role).toBe("viewer");
  });

  test("an_existing_account_accepts_an_invitation_without_a_new_organization", async () => {
    const auth = testAuth(ctx, { signup: "open" });
    const owner = await signUp(auth, "owner@example.com");
    const other = await signUp(auth, "other@example.com");
    const { org, invitation } = await invite(auth, owner.headers, "other@example.com");
    await auth.api.acceptInvitation({
      body: { invitationId: invitation.id },
      headers: other.headers,
    });
    const orgs = await organizations(auth, other.headers);
    expect(orgs).toHaveLength(2);
    expect(orgs.map((o) => o.id)).toContain(org.id);
  });

  test("an_expired_or_cancelled_invitation_is_refused_with_a_message", async () => {
    const auth = testAuth(ctx, { signup: "open" });
    const owner = await signUp(auth, "owner@example.com");
    const guest = await signUp(auth, "guest@example.com");
    const cancelled = await invite(auth, owner.headers, "guest@example.com");
    await auth.api.cancelInvitation({
      body: { invitationId: cancelled.invitation.id },
      headers: owner.headers,
    });
    const refusal = (invitationId: string) =>
      auth.api.acceptInvitation({ body: { invitationId }, headers: guest.headers }).then(
        () => "accepted",
        (error: Error) => error.message,
      );
    expect(await refusal(cancelled.invitation.id)).toMatch(/invitation/i);
    const expired = await invite(auth, owner.headers, "guest@example.com");
    await ctx.db.execute('UPDATE invitation SET "expiresAt" = ? WHERE id = ?', [
      new Date(Date.now() - 60_000).toISOString(),
      expired.invitation.id,
    ]);
    expect(await refusal(expired.invitation.id)).toMatch(/invitation/i);
  });

  test("roles_match_the_spec_table", () => {
    const table: [Permission, Record<Role, boolean>][] = [
      [{ organization: ["update"] }, { owner: true, admin: true, member: false, viewer: false }],
      [{ organization: ["delete"] }, { owner: true, admin: false, member: false, viewer: false }],
      [{ member: ["create"] }, { owner: true, admin: true, member: false, viewer: false }],
      [{ invitation: ["create"] }, { owner: true, admin: true, member: false, viewer: false }],
      [{ project: ["create"] }, { owner: true, admin: true, member: false, viewer: false }],
      [{ project: ["delete"] }, { owner: true, admin: true, member: false, viewer: false }],
      [{ project: ["move"] }, { owner: true, admin: true, member: false, viewer: false }],
      [{ source: ["write"] }, { owner: true, admin: true, member: true, viewer: false }],
      [{ key: ["write"] }, { owner: true, admin: true, member: true, viewer: false }],
      [{ dashboard: ["write"] }, { owner: true, admin: true, member: true, viewer: false }],
      [{ read: ["all"] }, { owner: true, admin: true, member: true, viewer: true }],
    ];
    for (const [permission, expected] of table)
      for (const role of ["owner", "admin", "member", "viewer"] as Role[])
        expect({ permission, role, allowed: can(role, permission) }).toEqual({
          permission,
          role,
          allowed: expected[role],
        });
  });

  test("project_slugs_are_unique_per_organization", async () => {
    const auth = testAuth(ctx, { signup: "open" });
    const [a] = await organizations(auth, (await signUp(auth, "a@example.com")).headers);
    const [b] = await organizations(auth, (await signUp(auth, "b@example.com")).headers);
    const input = { name: "Shop", retention_days: 30 };
    expect((await saveProduct(ctx.db, null, input, a?.id)).slug).toBe("shop");
    expect((await saveProduct(ctx.db, null, input, b?.id)).slug).toBe("shop");
    expect((await saveProduct(ctx.db, null, input, a?.id)).slug).toBe("shop-2");
  });

  test("existing_projects_join_the_first_accounts_organization", async () => {
    const before = await saveProduct(ctx.db, null, { name: "Older", retention_days: 30 });
    const auth = testAuth(ctx, { signup: "invite" });
    const [org] = await organizations(auth, (await signUp(auth, "first@example.com")).headers);
    const { rows } = await ctx.db.execute("SELECT org_id FROM products WHERE id = ?", [before.id]);
    expect(rows[0]?.org_id).toBe(org?.id as string);
  });

  test("an_organization_never_takes_a_page_address", async () => {
    const auth = testAuth(ctx, { signup: "open" });
    // A person named after a page gets the next free slug for their organization.
    const [own] = await organizations(
      auth,
      (await signUp(auth, "e@example.com", "Events")).headers,
    );
    expect(own?.slug).toBe("events-2");
    const owner = (await signUp(auth, "o@example.com", "Owner")).headers;
    const create = (slug: string) =>
      authRequest(auth, "/organization/create", { name: "Mine", slug }, owner);
    for (const slug of ["settings", "sign-in", "projects", "api", "join"]) {
      const refused = await create(slug);
      expect({ slug, ok: refused.ok }).toEqual({ slug, ok: false });
    }
    expect((await create("acme")).ok).toBe(true);
    const renamed = await authRequest(
      auth,
      "/organization/update",
      { data: { slug: "consent" } },
      owner,
    );
    expect(renamed.ok).toBe(false);
  });
});
