// Accounts: Better Auth inside the dashboard, on the same management database as everything
// else (the Tako database under Tako through libSQL, or the bun:sqlite file without it).
// Its tables come from migrations/, generated with apps/dashboard/scripts/auth-schema.ts.
import type { Database } from "bun:sqlite";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { betterAuth, getCurrentAdapter } from "better-auth";
import { APIError } from "better-auth/api";
import { admin, organization } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { tako } from "tako.sh";
import type { BunDb } from "../db/bun-db";
import type { Db } from "../db/db";
import { managementDb, takoDatabase } from "../db/open";
import { adoptOrphanProjects } from "../db/products";
import { projectSlug } from "../db/sources";
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

export interface AuthOptions {
  database: { bun: Database } | { libsql: { url: string; authToken: string } };
  /** Highkey's own tables, for the first account to adopt existing projects. */
  db?: Db;
  /** The dashboard's public origin. */
  publicUrl: string;
  secret: string | undefined;
  mailer: Mailer | null;
  signup: "open" | "invite";
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
  let self: { api: { createOrganization(input: unknown): Promise<unknown> } } | null = null;
  const instance = betterAuth({
    appName: "Highkey",
    baseURL: options.publicUrl,
    secret: options.secret,
    trustedOrigins: [new URL(options.publicUrl).origin],
    database,
    emailAndPassword: { enabled: true, minPasswordLength: 10 },
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
