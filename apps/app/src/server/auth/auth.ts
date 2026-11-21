// Accounts: Better Auth inside the dashboard, on the same management database as everything
// else (the Tako database under Tako through libSQL, or the bun:sqlite file without it).
// Its tables come from migrations/, generated with apps/app/scripts/auth-schema.ts.
import type { Database } from "bun:sqlite";
import { apiKey } from "@better-auth/api-key";
import { cimd } from "@better-auth/cimd";
import { mcp } from "@better-auth/mcp";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { betterAuth, getCurrentAdapter } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { admin, jwt, organization, twoFactor } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { tako } from "tako.sh";
import type { BunDb } from "../db/bun-db";
import type { Db } from "../db/db";
import { managementDb, takoDatabase } from "../db/open";
import { adoptOrphanProjects } from "../db/products";
import { projectSlug } from "../db/sources";
import { RESERVED_SLUGS } from "../../lib/auth-routes";
import { cimdFetch } from "./cimd-fetch";
import { keyFrom } from "./keys";
import { forgetOrganization, projectCount } from "./org-cleanup";
import { type Mailer, resendMailer, type SocialProviders, socialFromEnv } from "./mailer";
import { ac, roles } from "./roles";
import { signupPolicy } from "./signup";

export { type Mailer, memoryMailer } from "./mailer";

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
  /**
   * Runs before a person deletes their own account: refuses while they are the only owner of an
   * organization with other members, and deletes what goes with them (deletion.ts).
   */
  beforeDeleteUser?: (userId: string) => Promise<void>;
  /** GitHub and Google sign-in, each present only when configured. */
  social?: SocialProviders;
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

/** A free organization slug from a name: `ada`, else `ada-2`, `ada-3`… (never a page's address). */
async function freeSlug(adapter: Adapter, name: string): Promise<string> {
  const base = projectSlug(name);
  for (let suffix = 1; ; suffix++) {
    const slug = suffix === 1 ? base : `${base}-${suffix}`;
    if (RESERVED_SLUGS.has(slug)) continue;
    const taken = await adapter.findOne({
      model: "organization",
      where: [{ field: "slug", value: slug }],
    });
    if (!taken) return slug;
  }
}

const ROLE_PHRASES: Record<string, string> = {
  owner: "an owner",
  admin: "an admin",
  member: "a member",
  viewer: "a viewer",
};

/** The Join page for an invitation. */
export function invitationLink(publicUrl: string, invitationId: string): string {
  return `${new URL(publicUrl).origin}/join/${invitationId}`;
}

export function createAuth(options: AuthOptions) {
  const mailer: Mailer | null = options.mailer;
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
    // With email, addresses are verified before sign-in and passwords reset by email; without
    // it (a typical self-host) verification is off and the server admin issues reset links.
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      requireEmailVerification: mailer !== null,
      sendResetPassword: mailer
        ? async ({ user, url }) =>
            mailer.send({
              to: user.email,
              subject: "Reset your Highkey password",
              text: `Someone asked to reset the password of your Highkey account (${user.email}). To choose a new password, open this link within an hour:\n\n${url}\n\nIf it was not you, ignore this email; your password stays as it is.`,
            })
        : undefined,
    },
    emailVerification: mailer
      ? {
          sendOnSignUp: true,
          // An unverified sign-in sends a fresh link: an expired one is never a dead end, and
          // accounts made before email was configured verify on their next sign-in.
          sendOnSignIn: true,
          autoSignInAfterVerification: true,
          sendVerificationEmail: async ({ user, url }) =>
            mailer.send({
              to: user.email,
              subject: "Verify your email for Highkey",
              text: `Open this link to verify ${user.email} and sign in to Highkey:\n\n${url}\n\nIf you did not sign up for Highkey, ignore this email.`,
            }),
        }
      : undefined,
    socialProviders: options.social ?? {},
    // People delete their own accounts (with their password), by the rules in deletion.ts.
    user: {
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          try {
            await options.beforeDeleteUser?.(user.id);
          } catch (error) {
            const status = (error as { status?: number }).status;
            if (status === 409)
              throw new APIError("CONFLICT", { message: (error as Error).message });
            throw error;
          }
        },
      },
    },
    hooks: {
      // An invitation's response carries the link to its Join page, to copy when there is no
      // email (and to resend by hand when there is).
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/organization/invite-member") return;
        const invitation = ctx.context.returned as { id?: unknown } | null;
        if (invitation && typeof invitation.id === "string")
          return ctx.json({
            ...invitation,
            link: invitationLink(options.publicUrl, invitation.id),
          });
      }),
    },
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
      // The admin plugin's own endpoints: the server admin works through /api/admin, which keeps
      // Highkey's rules (no impersonation, the deletion rules, reset links, not set passwords).
      ...[
        "ban-user",
        "create-user",
        "get-user",
        "has-permission",
        "impersonate-user",
        "list-user-sessions",
        "list-users",
        "remove-user",
        "revoke-user-session",
        "revoke-user-sessions",
        "set-role",
        "set-user-password",
        "stop-impersonating",
        "unban-user",
        "update-user",
      ].map((path) => `/admin/${path}`),
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
          // Only the bootstrap admin gets an initial organization, including any legacy projects.
          // Everyone else can wait for an invitation or explicitly create an organization.
          after: async (user, ctx) => {
            if (!("role" in user) || user.role !== "admin") return;
            const adapter = await adapterOf(ctx);
            if (!adapter || !self) return;
            const org = (await self.api.createOrganization({
              body: { name: user.name, slug: await freeSlug(adapter, user.name), userId: user.id },
            })) as { id: string };
            await adapter.updateMany({
              model: "session",
              where: [{ field: "userId", value: user.id }],
              update: { activeOrganizationId: org.id },
            });
            if (options.db) await adoptOrphanProjects(options.db, org.id);
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
        sendInvitationEmail: mailer
          ? async ({ email, role, organization: org, inviter, id }) =>
              mailer.send({
                to: email,
                subject: `${inviter.user.name} invited you to ${org.name} on Highkey`,
                text: `${inviter.user.name} (${inviter.user.email}) invited you to join ${org.name} on Highkey as ${ROLE_PHRASES[role] ?? role}. Open this link within 7 days to accept:\n\n${invitationLink(options.publicUrl, id)}\n\nIf you were not expecting this, ignore this email.`,
              })
          : undefined,
        // An owner can require two-factor codes of everyone in the organization.
        schema: {
          organization: {
            additionalFields: {
              requireTwoFactor: {
                type: "boolean",
                required: false,
                defaultValue: false,
                input: true,
              },
            },
          },
        },
        organizationHooks: {
          // An organization's address is /<slug>/…; it may not hide one of Highkey's pages.
          beforeCreateOrganization: async ({ organization: org }) => {
            if (RESERVED_SLUGS.has(String(org.slug)))
              throw new APIError("BAD_REQUEST", {
                message: `“${org.slug}” is one of Highkey’s own addresses; choose another slug`,
              });
          },
          // An organization goes only once it has no projects (deleted ones count until wiped);
          // then its keys and agent connections go with it.
          beforeDeleteOrganization: async ({ organization: org }) => {
            if (options.db && (await projectCount(options.db, org.id)) > 0)
              throw new APIError("BAD_REQUEST", {
                message:
                  "Delete or move this organization's projects first; deleted projects count until they are wiped 7 days later",
              });
          },
          afterDeleteOrganization: async ({ organization: org }) => {
            if (options.db) await forgetOrganization(options.db, org.id);
          },
          beforeUpdateOrganization: async ({ organization: changes, user, member }) => {
            if (changes.slug !== undefined && RESERVED_SLUGS.has(String(changes.slug)))
              throw new APIError("BAD_REQUEST", {
                message: `“${changes.slug}” is one of Highkey’s own addresses; choose another slug`,
              });
            if (changes.requireTwoFactor === undefined) return;
            if (!String(member.role).split(",").includes("owner"))
              throw new APIError("FORBIDDEN", {
                message: "Only an owner can require two-factor codes",
              });
            if (changes.requireTwoFactor && !user.twoFactorEnabled)
              throw new APIError("FORBIDDEN", {
                message: "Turn on two-factor codes for your own account before requiring them",
              });
          },
        },
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
      // TOTP codes from an authenticator app, with backup codes.
      twoFactor({ issuer: "Highkey" }),
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

/** Resend, when `HIGHKEY_RESEND_API_KEY` and `HIGHKEY_EMAIL_FROM` are both set. */
function mailerFromSettings(): Mailer | null {
  const key = setting("HIGHKEY_RESEND_API_KEY");
  const from = setting("HIGHKEY_EMAIL_FROM");
  return key && from ? resendMailer(key, from) : null;
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
      mailer: mailerFromSettings(),
      beforeDeleteUser: async (userId) => {
        const [{ prepareUserDeletion }, { apiContext }] = await Promise.all([
          import("../deletion"),
          import("../api/context"),
        ]);
        await prepareUserDeletion(apiContext(), userId);
      },
      signup: signupPolicy(process.env.HIGHKEY_SIGNUP),
      social: socialFromEnv({
        HIGHKEY_GITHUB_CLIENT_ID: setting("HIGHKEY_GITHUB_CLIENT_ID"),
        HIGHKEY_GITHUB_CLIENT_SECRET: setting("HIGHKEY_GITHUB_CLIENT_SECRET"),
        HIGHKEY_GOOGLE_CLIENT_ID: setting("HIGHKEY_GOOGLE_CLIENT_ID"),
        HIGHKEY_GOOGLE_CLIENT_SECRET: setting("HIGHKEY_GOOGLE_CLIENT_SECRET"),
      }),
    });
  })().catch((error) => {
    instance = null;
    throw error;
  });
  return instance;
}
