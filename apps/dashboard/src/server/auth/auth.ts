// Accounts: Better Auth inside the dashboard, on the same management database as everything
// else (the Tako database under Tako through libSQL, or the bun:sqlite file without it).
// Its tables come from migrations/, generated with apps/dashboard/scripts/auth-schema.ts.
import type { Database } from "bun:sqlite";
import { apiKey } from "@better-auth/api-key";
import { cimd } from "@better-auth/cimd";
import { mcp } from "@better-auth/mcp";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { betterAuth, getCurrentAdapter } from "better-auth";
import { APIError } from "better-auth/api";
import { admin, jwt, organization } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { tako } from "tako.sh";
import type { BunDb } from "../db/bun-db";
import type { Db } from "../db/db";
import { managementDb, takoDatabase } from "../db/open";
import { adoptOrphanProjects } from "../db/products";
import { projectSlug } from "../db/sources";
import { cimdFetch } from "./cimd-fetch";
import { keyFrom } from "./keys";
import { ac, roles } from "./roles";

/** Sends the account emails: verification, password reset, invitations. */
export interface Mailer {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
}

/** A mailer that keeps what it was asked to send, for tests. */
export function memoryMailer(): Mailer & { sent: { to: string; subject: string; text: string }[] } {
  const sent: { to: string; subject: string; text: string }[] = [];
  return {
    sent,
    async send(message) {
      sent.push(message);
    },
  };
}

/** How many requests an API key may make, per window; tests pass a smaller one. */
export const KEY_RATE_LIMIT = { timeWindow: 60_000, maxRequests: 1_000 };

export interface AuthOptions {
  database: { bun: Database } | { libsql: { url: string; authToken: string } };
  /** Highkey's own tables, for the first account to adopt existing projects. */
  db?: Db;
  /** The dashboard's public origin. */
  publicUrl: string;
  secret: string | undefined;
  mailer: Mailer | null;
  signup: "open" | "invite";
  keyRateLimit?: { timeWindow: number; maxRequests: number };
  /** How agents' client metadata documents are fetched; tests serve their own. */
  cimdFetch?: Parameters<typeof cimd>[0]["fetchClientMetadataResource"];
}

/** The scopes agents ask for; `mcp:write` adds the changing tools to `mcp:read`'s. */
export const MCP_SCOPES = ["openid", "profile", "offline_access", "mcp:read", "mcp:write"];

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether agents can sign in over OAuth at this address: OAuth needs HTTPS, except on loopback for
 * development. Without it (a plain-HTTP address on a private network) agents use API keys.
 */
export function oauthAvailable(publicUrl: string): boolean {
  const url = new URL(publicUrl);
  return (
    url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
  );
}

/** The MCP resource agents' tokens are bound to: the `/mcp` address users are shown. */
export function mcpResource(publicUrl: string): string {
  return `${new URL(publicUrl).origin}/mcp`;
}

/** An invitation is pending for `email` and not yet expired. */
type Adapter = {
  count(input: { model: string; where?: { field: string; value: unknown }[] }): Promise<number>;
  findMany<T>(input: { model: string; where?: { field: string; value: unknown }[] }): Promise<T[]>;
  findOne<T>(input: {
    model: string;
    where: { field: string; value: unknown }[];
  }): Promise<T | null>;
  updateMany(input: {
    model: string;
    where: { field: string; value: unknown }[];
    update: Record<string, unknown>;
  }): Promise<unknown>;
};

/**
 * The adapter for a hook: the open transaction's while sign-up runs in one. Querying through the
 * plain adapter inside that transaction would wait forever on SQLite's single connection.
 */
async function adapterOf(
  ctx: { context: { adapter: unknown } } | null | undefined,
): Promise<Adapter | undefined> {
  if (!ctx) return undefined;
  return (await getCurrentAdapter(ctx.context.adapter as never)) as unknown as Adapter;
}

async function invited(adapter: Adapter, email: string): Promise<boolean> {
  const pending = await adapter.findMany<{ expiresAt: Date | string }>({
    model: "invitation",
    where: [
      { field: "email", value: email.toLowerCase() },
      { field: "status", value: "pending" },
    ],
  });
  return pending.some((i) => new Date(i.expiresAt).getTime() > Date.now());
}

/** A free organization slug from a name: `ada`, else `ada-2`, `ada-3`… */
async function freeSlug(adapter: Adapter, name: string): Promise<string> {
  const base = projectSlug(name);
  for (let suffix = 1; ; suffix++) {
    const slug = suffix === 1 ? base : `${base}-${suffix}`;
    const taken = await adapter.findOne({
      model: "organization",
      where: [{ field: "slug", value: slug }],
    });
    if (!taken) return slug;
  }
}

export function createAuth(options: AuthOptions) {
  const database =
    "bun" in options.database
      ? options.database.bun
      : {
          dialect: new LibsqlDialect(options.database.libsql),
          type: "sqlite" as const,
          transaction: true,
        };
  // The instance, for hooks that call its API (they run only after it exists).
  let self: {
    api: { createOrganization(input: unknown): Promise<unknown> };
    $context: Promise<{ adapter: unknown }>;
  } | null = null;
  /** The role `userId` holds in `orgId` now, read through the instance (and any open transaction). */
  const roleIn = async (orgId: string, userId: string): Promise<string | null> => {
    if (!self) return null;
    const adapter = await adapterOf({ context: await self.$context });
    const member = await adapter?.findOne<{ role: string }>({
      model: "member",
      where: [
        { field: "organizationId", value: orgId },
        { field: "userId", value: userId },
      ],
    });
    return member?.role ?? null;
  };
  const instance = betterAuth({
    appName: "Highkey",
    baseURL: options.publicUrl,
    secret: options.secret,
    trustedOrigins: [new URL(options.publicUrl).origin],
    database,
    emailAndPassword: { enabled: true, minPasswordLength: 10 },
    // API keys are made, listed and revoked only through Highkey's /api/keys, which scope them to
    // an organization; the plugin's own endpoints stay closed.
    disabledPaths: [
      // The JWT plugin's session-to-JWT endpoint: agents get tokens only through OAuth.
      "/token",
      "/api-key/create",
      "/api-key/get",
      "/api-key/list",
      "/api-key/update",
      "/api-key/delete",
    ],
    databaseHooks: {
      user: {
        create: {
          // Who may sign up: anyone when sign-up is open; otherwise the very first account (who
          // becomes the server admin) and people with a pending invitation.
          before: async (user, ctx) => {
            const adapter = await adapterOf(ctx);
            if (!adapter) return;
            const first = (await adapter.count({ model: "user" })) === 0;
            if (options.signup === "invite" && !first && !(await invited(adapter, user.email)))
              throw new APIError("FORBIDDEN", {
                message: "Sign-up is by invitation; ask an organization owner to invite you",
              });
            if (first) return { data: { ...user, role: "admin" } };
          },
          // Signing up on your own creates an organization you own; joining by invitation does
          // not. The first account's organization takes in projects that have none.
          after: async (user, ctx) => {
            const adapter = await adapterOf(ctx);
            if (!adapter || !self || (await invited(adapter, user.email))) return;
            const org = (await self.api.createOrganization({
              body: { name: user.name, slug: await freeSlug(adapter, user.name), userId: user.id },
            })) as { id: string };
            await adapter.updateMany({
              model: "session",
              where: [{ field: "userId", value: user.id }],
              update: { activeOrganizationId: org.id },
            });
            if (options.db && (await adapter.count({ model: "user" })) === 1)
              await adoptOrphanProjects(options.db, org.id);
          },
        },
      },
      session: {
        create: {
          // A new session starts in the person's first organization.
          before: async (session, ctx) => {
            const adapter = await adapterOf(ctx);
            if (!adapter) return;
            const [first] = await adapter.findMany<{ organizationId: string; createdAt: Date }>({
              model: "member",
              where: [{ field: "userId", value: session.userId }],
            });
            if (first) return { data: { ...session, activeOrganizationId: first.organizationId } };
          },
        },
      },
    },
    plugins: [
      organization({
        ac,
        roles,
        creatorRole: "owner",
        invitationExpiresIn: 7 * 24 * 60 * 60,
      }),
      // Keys belong to the person who made them; the organization and access are their metadata.
      apiKey({
        references: "user",
        enableMetadata: true,
        defaultPrefix: "hk_",
        apiKeyHeaders: "x-api-key",
        customAPIKeyGetter: (ctx) => (ctx.headers ? keyFrom(ctx.headers) : null),
        rateLimit: { enabled: true, ...(options.keyRateLimit ?? KEY_RATE_LIMIT) },
      }),
      // Agents sign in over OAuth 2.1. Before consent the person picks the organization the
      // connection is for (the select-organization page sets it active, then continues); the
      // consent is stored for that organization, and each token names it in its `org` claim.
      ...(oauthAvailable(options.publicUrl)
        ? [
            jwt({ disableSettingJwtHeader: true }),
            mcp({
              loginPage: "/sign-in",
              consentPage: "/consent",
              resource: mcpResource(options.publicUrl),
              scopes: MCP_SCOPES,
              accessTokenExpiresIn: 900,
              postLogin: {
                page: "/select-organization",
                // Always ask first; on return, go on only with an organization the person is in.
                shouldRedirect: async ({ user, session, isContinuation }) => {
                  if (!isContinuation) return true;
                  const org = session.activeOrganizationId as string | null | undefined;
                  return !(org && (await roleIn(org, user.id)));
                },
                consentReferenceId: async ({ user, session }) => {
                  const org = session.activeOrganizationId as string | null | undefined;
                  if (!org || !(await roleIn(org, user.id)))
                    throw new APIError("FORBIDDEN", {
                      message: "Choose an organization you belong to for this connection",
                    });
                  return org;
                },
              },
              // Every token (and every refresh) checks the person still belongs to the organization,
              // and that a viewer was not granted write access.
              customAccessTokenClaims: async ({ user, referenceId, scopes }) => {
                const role = user && referenceId ? await roleIn(referenceId, user.id) : null;
                if (!role)
                  throw new APIError("FORBIDDEN", {
                    message: "This connection's person is no longer a member of its organization",
                  });
                if (scopes.includes("mcp:write") && role === "viewer")
                  throw new APIError("FORBIDDEN", {
                    message: "A viewer can grant read-only access",
                  });
                return { org: referenceId };
              },
            }),
            cimd({
              fetchClientMetadataResource: options.cimdFetch ?? cimdFetch,
              metadataProfile: "mcp-2026-07-28",
            }),
          ]
        : []),
      // The server admin (users with role "admin"), above every organization.
      admin({ adminRoles: ["admin"] }),
      // Must stay last, so cookies set by server-side calls reach TanStack Start's response.
      tanstackStartCookies(),
    ],
  });
  self = instance as unknown as typeof self;
  return instance;
}

export type Auth = ReturnType<typeof createAuth>;

function setting(name: string): string | undefined {
  try {
    return (tako.secrets as Record<string, string | undefined>)[name] ?? process.env[name];
  } catch {
    return process.env[name];
  }
}

let instance: Promise<Auth> | null = null;

/** The process's Better Auth, on the management database. */
export function getAuth(): Promise<Auth> {
  instance ??= (async () => {
    const binding = takoDatabase();
    const database = binding ? { libsql: binding } : { bun: ((await managementDb()) as BunDb).raw };
    return createAuth({
      database,
      db: await managementDb(),
      publicUrl: process.env.HIGHKEY_PUBLIC_URL ?? "http://127.0.0.1:3000",
      secret: setting("BETTER_AUTH_SECRET"),
      mailer: null,
      signup: process.env.HIGHKEY_SIGNUP === "open" ? "open" : "invite",
    });
  })().catch((error) => {
    instance = null;
    throw error;
  });
  return instance;
}
