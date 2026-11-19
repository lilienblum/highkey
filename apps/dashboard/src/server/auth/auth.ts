// Accounts: Better Auth inside the dashboard, on the same management database as everything
// else (the Tako database under Tako through libSQL, or the bun:sqlite file without it).
// Its tables come from migrations/, generated with apps/dashboard/scripts/auth-schema.ts.
import type { Database } from "bun:sqlite";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { betterAuth } from "better-auth";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { tako } from "tako.sh";
import type { BunDb } from "../db/bun-db";
import { managementDb, takoDatabase } from "../db/open";

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
  /** The dashboard's public origin. */
  publicUrl: string;
  secret: string | undefined;
  mailer: Mailer | null;
  signup: "open" | "invite";
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
  return betterAuth({
    appName: "Highkey",
    baseURL: options.publicUrl,
    secret: options.secret,
    trustedOrigins: [new URL(options.publicUrl).origin],
    database,
    emailAndPassword: { enabled: true, minPasswordLength: 10 },
    // Must stay last, so cookies set by server-side calls reach TanStack Start's response.
    plugins: [tanstackStartCookies()],
  });
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
