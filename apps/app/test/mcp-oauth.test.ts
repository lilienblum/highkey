// Agents connect to /mcp over OAuth 2.1: discovery, the authorization flow with its organization
// choice and consent, tokens bound to that organization, revocation, and the API-key-only
// read-only address. The client's metadata document is served by a stub transport.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { type Auth, createAuth, oauthAvailable } from "../src/server/auth/auth";
import type { BunDb } from "../src/server/db/bun-db";
import { capped, MAX_METADATA_BYTES, pinnedAddress } from "../src/server/auth/cimd-fetch";
import { joinAs, signUpOwner, TEST_ORIGIN, testAuth } from "./auth-helpers";
import { call, project, type TestContext, testContext } from "./helpers";

const CLIENT = "https://agent.example/client.json";
const REDIRECT = "http://127.0.0.1:33418/callback";
const RESOURCE = `${TEST_ORIGIN}/mcp`;
const METADATA = {
  client_id: CLIENT,
  client_name: "Test agent",
  redirect_uris: [REDIRECT],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

let ctx: TestContext;
let auth: Auth;
beforeEach(async () => {
  ctx = await testContext();
  auth = testAuth(ctx, { cimdFetch: async () => Response.json(METADATA) });
  ctx.auth = async () => auth;
}, 300_000);
afterEach(() => ctx?.cleanup());

const cookie = (who: Headers) => who.get("cookie") as string;

function authPost(path: string, who: Headers, body: unknown) {
  return auth.handler(
    new Request(`${TEST_ORIGIN}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: TEST_ORIGIN, cookie: cookie(who) },
      body: JSON.stringify(body),
    }),
  );
}

function tokenRequest(fields: Record<string, string>) {
  return auth.handler(
    new Request(`${TEST_ORIGIN}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CLIENT, resource: RESOURCE, ...fields }),
    }),
  );
}

/**
 * Runs the authorization flow as `who`: authorize, pick `org` on the select-organization page
 * (or keep the active one), consent to `grant`, and trade the code for tokens.
 */
async function connect(
  who: Headers,
  grant: string,
  options: { org?: string; request?: string } = {},
): Promise<Response> {
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT,
    redirect_uri: REDIRECT,
    scope: options.request ?? "openid offline_access mcp:read mcp:write",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "state",
    resource: RESOURCE,
  });
  const authorized = await auth.handler(
    new Request(`${TEST_ORIGIN}/api/auth/oauth2/authorize?${query}`, { headers: who }),
  );
  const chooser = authorized.headers.get("location") as string;
  expect(chooser).toStartWith("/select-organization?");
  if (options.org)
    await auth.api.setActiveOrganization({ body: { organizationId: options.org }, headers: who });
  const continued = await authPost("/oauth2/continue", who, {
    postLogin: true,
    oauth_query: chooser.split("?")[1],
  });
  const consent = ((await continued.json()) as { url: string }).url;
  expect(consent).toStartWith("/consent?");
  const consented = await authPost("/oauth2/consent", who, {
    accept: true,
    scope: grant,
    oauth_query: consent.split("?")[1],
  });
  const back = consented.ok ? new URL(((await consented.json()) as { url: string }).url) : null;
  const code = back?.searchParams.get("code");
  if (!code) return consented;
  return tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
  });
}

async function accessToken(who: Headers, grant: string, org?: string) {
  const response = await connect(who, grant, { org });
  expect(response.status).toBe(200);
  return (await response.json()) as { access_token: string; refresh_token: string };
}

/** One JSON-RPC call to an MCP address with `credential` as its only authentication. */
async function rpc(path: string, credential: string | null, method: string, params = {}) {
  return call(
    ctx,
    "POST",
    path,
    { jsonrpc: "2.0", id: 1, method, params },
    {
      cookie: "",
      origin: "",
      accept: "application/json, text/event-stream",
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),
    },
  );
}

const toolNames = async (path: string, credential: string) =>
  ((await rpc(path, credential, "tools/list")).json.result.tools as { name: string }[]).map(
    (t) => t.name,
  );

async function orgOf(who: Headers): Promise<string> {
  const session = await auth.api.getSession({ headers: who });
  return session?.session.activeOrganizationId as string;
}

describe("agents over OAuth", () => {
  test("discovery_documents_name_the_resource", async () => {
    const resource = await auth.handler(
      new Request(`${TEST_ORIGIN}/.well-known/oauth-protected-resource/mcp`),
    );
    const protectedResource = (await resource.json()) as Record<string, unknown>;
    expect(protectedResource).toMatchObject({
      resource: RESOURCE,
      authorization_servers: [`${TEST_ORIGIN}/api/auth`],
      scopes_supported: ["mcp:read", "mcp:write"],
    });
    const server = await auth.handler(
      new Request(`${TEST_ORIGIN}/.well-known/oauth-authorization-server/api/auth`),
    );
    expect(await server.json()).toMatchObject({
      issuer: `${TEST_ORIGIN}/api/auth`,
      client_id_metadata_document_supported: true,
      scopes_supported: expect.arrayContaining(["mcp:read", "mcp:write"]),
    });
    // An agent without a token is told where to start.
    const challenge = await rpc("/api/mcp", null, "tools/list");
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toContain(
      `${TEST_ORIGIN}/.well-known/oauth-protected-resource/mcp`,
    );
  });

  test("the_full_flow_issues_a_token_bound_to_the_chosen_organization", async () => {
    await project(ctx, "Shop");
    // The person also belongs to a second organization, and connects the agent to that one.
    const other = await signUpOwner(auth, "other@example.com");
    await call(
      ctx,
      "POST",
      "/api/products",
      { name: "Elsewhere", retention_days: 30 },
      {
        cookie: cookie(other),
      },
    );
    const invitation = (await auth.api.createInvitation({
      body: { email: "owner@highkey.test", role: "admin", organizationId: await orgOf(other) },
      headers: other,
    })) as { id: string };
    const home = await orgOf(ctx.session);
    await auth.api.acceptInvitation({
      body: { invitationId: invitation.id },
      headers: ctx.session,
    });
    await auth.api.setActiveOrganization({ body: { organizationId: home }, headers: ctx.session });
    const { access_token } = await accessToken(ctx.session, "openid mcp:read", await orgOf(other));
    const claims = JSON.parse(
      Buffer.from(access_token.split(".")[1] as string, "base64url").toString(),
    );
    expect(claims.org).toBe(await orgOf(other));
    expect(claims.aud).toContain(RESOURCE);
    const listed = await rpc("/api/mcp", access_token, "tools/call", {
      name: "list_projects",
      arguments: {},
    });
    const text = listed.json.result.content[0].text as string;
    expect(text).toContain("Elsewhere");
    expect(text).not.toContain("Shop");
  });

  test("a_read_grant_lists_only_read_tools", async () => {
    const read = (await accessToken(ctx.session, "openid mcp:read")).access_token;
    expect(await toolNames("/api/mcp", read)).not.toContain("save_dashboard");
    const refused = await rpc("/api/mcp", read, "tools/call", {
      name: "create_project",
      arguments: {},
    });
    expect(refused.json.error.message).toContain("Unknown tool");
    const write = (await accessToken(ctx.session, "openid mcp:read mcp:write")).access_token;
    expect(await toolNames("/api/mcp", write)).toContain("save_dashboard");
  });

  test("a_viewer_cannot_grant_write", async () => {
    const viewer = await joinAs(auth, ctx.session, "viewer@example.com", "viewer");
    const refused = await connect(viewer, "openid mcp:read mcp:write");
    expect(refused.ok).toBe(false);
    expect(await refused.text()).toContain("read-only");
    const { access_token } = await accessToken(viewer, "openid mcp:read");
    expect(await toolNames("/api/mcp", access_token)).not.toContain("save_dashboard");
  });

  test("a_revoked_connection_is_refused_before_its_token_expires", async () => {
    const { access_token } = await accessToken(ctx.session, "openid mcp:read");
    expect((await rpc("/api/mcp", access_token, "tools/list")).status).toBe(200);
    const connections = await call(ctx, "GET", "/api/connections");
    expect(connections.json).toMatchObject([
      {
        client: { id: CLIENT, name: "Test agent" },
        access: "read",
        user: { email: "owner@highkey.test" },
      },
    ]);
    expect((await call(ctx, "DELETE", `/api/connections/${connections.json[0].id}`)).status).toBe(
      204,
    );
    expect((await rpc("/api/mcp", access_token, "tools/list")).status).toBe(401);
    expect((await call(ctx, "GET", "/api/connections")).json).toEqual([]);
  });

  test("a_member_who_left_cannot_use_their_token", async () => {
    const member = await joinAs(auth, ctx.session, "leaving@example.com", "member");
    const tokens = await accessToken(member, "openid offline_access mcp:read mcp:write");
    expect(await toolNames("/api/mcp", tokens.access_token)).toContain("save_dashboard");
    await auth.api.removeMember({
      body: { memberIdOrEmail: "leaving@example.com" },
      headers: ctx.session,
    });
    const refused = await rpc("/api/mcp", tokens.access_token, "tools/list");
    expect(refused.status).toBe(403);
    expect(refused.json.code).toBe("not_a_member");
    const refreshed = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    });
    expect(refreshed.ok).toBe(false);
  });

  test("cimd_fetch_refuses_private_addresses_and_redirects", async () => {
    for (const url of [
      "http://agent.example/client.json",
      "https://agent.example:8443/client.json",
      "https://127.0.0.1/client.json",
      "https://10.0.0.8/client.json",
      "https://[::1]/client.json",
      "https://[::ffff:127.0.0.1]/client.json",
      "https://169.254.169.254/latest",
    ])
      await expect(pinnedAddress(new URL(url))).rejects.toThrow();
    const resolve = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "192.168.1.5", family: 4 },
    ];
    await expect(pinnedAddress(new URL("https://agent.example/c.json"), resolve)).rejects.toThrow(
      "public",
    );
    const one = async () => [{ address: "93.184.216.34", family: 4 }];
    expect(await pinnedAddress(new URL("https://agent.example/c.json"), one)).toEqual({
      address: "93.184.216.34",
      family: 4,
    });
    const redirect = new Response(null, { status: 302, headers: { location: "http://10.0.0.1/" } });
    await expect(capped(redirect)).rejects.toThrow("redirect");
    await expect(capped(new Response("x".repeat(MAX_METADATA_BYTES + 1)))).rejects.toThrow(
      "64 KiB",
    );
    const ok = await capped(Response.json(METADATA));
    expect(await ok.json()).toEqual(METADATA);
  });

  test("the_read_only_address_takes_api_keys_only_and_only_reads", async () => {
    const key = async (access: string) =>
      (await call(ctx, "POST", "/api/keys", { name: access, access })).json.key as string;
    const reader = await key("read");
    const writer = await key("write");
    for (const credential of [reader, writer]) {
      const names = await toolNames("/api/read/mcp", credential);
      expect(names).toContain("describe_project");
      expect(names).not.toContain("save_dashboard");
    }
    // The full address takes keys too, and a write key reaches the changing tools there.
    expect(await toolNames("/api/mcp", writer)).toContain("save_dashboard");
    expect(await toolNames("/api/mcp", reader)).not.toContain("save_dashboard");
    // No session and no OAuth token on the read-only address.
    const session = await call(
      ctx,
      "POST",
      "/api/read/mcp",
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      {
        origin: "",
      },
    );
    expect(session.status).toBe(401);
    const { access_token } = await accessToken(ctx.session, "openid mcp:read");
    expect((await rpc("/api/read/mcp", access_token, "tools/list")).status).toBe(401);
  });

  test("without_https_agents_use_api_keys_and_the_server_still_starts", async () => {
    expect(oauthAvailable("https://highkey.example")).toBe(true);
    expect(oauthAvailable("http://127.0.0.1:3000")).toBe(true);
    expect(oauthAvailable("http://localhost:3000")).toBe(true);
    expect(oauthAvailable("http://192.168.1.10:3000")).toBe(false);
    const lan = "http://192.168.1.10:3000";
    const plain = createAuth({
      database: { bun: (ctx.db as BunDb).raw },
      db: ctx.db,
      publicUrl: lan,
      secret: "highkey-test-secret-at-least-32-characters",
      mailer: null,
      signup: "open",
    });
    ctx.auth = async () => plain;
    ctx.publicUrl = lan;
    const { handleApi } = await import("../src/server/api/router");
    const refused = await handleApi(
      new Request(`${lan}/api/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      ctx,
    );
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as { error: string }).error).toContain("API key");
  });
});
