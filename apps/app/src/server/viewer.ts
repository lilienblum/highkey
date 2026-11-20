// Who is looking at the dashboard, and what the account screens need to know: the signed-in
// person with their organizations, which sign-in options this server offers, an invitation's
// details for its Join page, and an agent's name for the consent page.
import { createServerFn } from "@tanstack/react-start";

export interface ViewerOrganization {
  id: string;
  name: string;
  slug: string;
  role: string;
  /** Its members must have two-factor codes on to open it. */
  requireTwoFactor: boolean;
}

export interface Viewer {
  user: { id: string; name: string; email: string; serverAdmin: boolean; twoFactor: boolean };
  activeOrganizationId: string | null;
  organizations: ViewerOrganization[];
}

export interface AuthSetup {
  /** Email is configured: verification, password reset and invitation emails. */
  email: boolean;
  /** Anyone may sign up, or only the first account and invited people. */
  signup: "open" | "invite";
  /** No account exists yet: the first one administers the server. */
  firstAccount: boolean;
  social: { github: boolean; google: boolean };
}

export interface InvitationDetails {
  id: string;
  email: string;
  role: string;
  organization: string;
  inviter: { name: string; email: string };
  expiresAt: string;
  status: "pending" | "accepted" | "rejected" | "canceled" | "expired";
}

async function context() {
  const [{ apiContext }, { getRequest }] = await Promise.all([
    import("./api/context"),
    import("@tanstack/react-start/server"),
  ]);
  return { ctx: apiContext(), request: getRequest() };
}

/** The signed-in person, or null. */
export const getViewer = createServerFn({ method: "GET" }).handler(
  async (): Promise<Viewer | null> => {
    const { ctx, request } = await context();
    const auth = await ctx.auth();
    const session = await auth.api.getSession({ headers: request.headers }).catch(async (error) => {
      // An outage is not a sign-out: say so instead of sending the person to sign in.
      const { failIfStorageDown } = await import("./auth/actor");
      await failIfStorageDown(ctx);
      throw error;
    });
    if (!session) return null;
    const { all } = await import("./db/db");
    const rows = await all<Omit<ViewerOrganization, "requireTwoFactor"> & { required: number }>(
      ctx.db,
      `SELECT o.id, o.name, o.slug, m.role, coalesce(o."requireTwoFactor", 0) AS required
       FROM member m JOIN organization o ON o.id = m."organizationId"
       WHERE m."userId" = ? ORDER BY o.name COLLATE NOCASE, o.id`,
      [session.user.id],
    );
    const organizations = rows.map(({ required, ...org }) => ({
      ...org,
      requireTwoFactor: Boolean(required),
    }));
    const user = session.user as typeof session.user & {
      role?: string | null;
      twoFactorEnabled?: boolean | null;
    };
    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        serverAdmin: user.role === "admin",
        twoFactor: Boolean(user.twoFactorEnabled),
      },
      activeOrganizationId: session.session.activeOrganizationId ?? null,
      organizations,
    };
  },
);

/** What the sign-in and sign-up screens offer on this server. */
export const getAuthSetup = createServerFn({ method: "GET" }).handler(
  async (): Promise<AuthSetup> => {
    const { ctx } = await context();
    const auth = await ctx.auth();
    const { one } = await import("./db/db");
    const users = await one<{ n: number }>(ctx.db, 'SELECT count(*) AS n FROM "user"');
    const options = auth.options as {
      emailVerification?: unknown;
      socialProviders?: { github?: unknown; google?: unknown };
    };
    return {
      email: Boolean(options.emailVerification),
      signup: process.env.HIGHKEY_SIGNUP === "open" ? "open" : "invite",
      firstAccount: Number(users?.n ?? 0) === 0,
      social: {
        github: Boolean(options.socialProviders?.github),
        google: Boolean(options.socialProviders?.google),
      },
    };
  },
);

const ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * An invitation's Join page details: who invited whom, to which organization, as what. Anyone
 * holding the link may read them, the way the email would show them; accepting needs the
 * invited person's account.
 */
export const getInvitationDetails = createServerFn({ method: "GET" })
  .validator((id: unknown) => {
    if (typeof id !== "string" || !ID.test(id)) throw new Error("Not an invitation link");
    return id;
  })
  .handler(async ({ data: id }): Promise<InvitationDetails | null> => {
    const { ctx } = await context();
    const { one } = await import("./db/db");
    const row = await one<{
      id: string;
      email: string;
      role: string | null;
      status: string;
      expires_at: string | number;
      organization: string;
      inviter_name: string;
      inviter_email: string;
    }>(
      ctx.db,
      `SELECT i.id, i.email, i.role, i.status, i."expiresAt" AS expires_at, o.name AS organization,
         u.name AS inviter_name, u.email AS inviter_email
       FROM invitation i JOIN organization o ON o.id = i."organizationId"
       JOIN "user" u ON u.id = i."inviterId" WHERE i.id = ?`,
      [id],
    );
    if (!row) return null;
    const expiresAt = new Date(row.expires_at);
    const status =
      row.status === "pending" && expiresAt.getTime() < Date.now()
        ? "expired"
        : (row.status as InvitationDetails["status"]);
    return {
      id: row.id,
      email: row.email,
      role: row.role ?? "member",
      organization: row.organization,
      inviter: { name: row.inviter_name, email: row.inviter_email },
      expiresAt: expiresAt.toISOString(),
      status,
    };
  });

export interface PendingInvitation {
  id: string;
  organization: string;
  role: string;
  inviter: string;
}

/** The invitations waiting for the signed-in person's email, for the no-organization page. */
export const getPendingInvitations = createServerFn({ method: "GET" }).handler(
  async (): Promise<PendingInvitation[]> => {
    const { ctx, request } = await context();
    const auth = await ctx.auth();
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return [];
    const { all } = await import("./db/db");
    const rows = await all<{
      id: string;
      organization: string;
      role: string | null;
      inviter: string;
      expires_at: string | number;
    }>(
      ctx.db,
      `SELECT i.id, o.name AS organization, i.role, u.name AS inviter, i."expiresAt" AS expires_at
       FROM invitation i JOIN organization o ON o.id = i."organizationId"
       JOIN "user" u ON u.id = i."inviterId"
       WHERE lower(i.email) = lower(?) AND i.status = 'pending'
       ORDER BY o.name COLLATE NOCASE, i.id`,
      [session.user.email],
    );
    return rows
      .filter((row) => new Date(row.expires_at).getTime() > Date.now())
      .map(({ expires_at: _, role, ...row }) => ({ ...row, role: role ?? "member" }));
  },
);

/** The name an agent registered with, for the consent page. */
export const getAgentName = createServerFn({ method: "GET" })
  .validator((clientId: unknown) => {
    if (typeof clientId !== "string" || clientId.length > 2048) throw new Error("Not a client");
    return clientId;
  })
  .handler(async ({ data: clientId }): Promise<string | null> => {
    const { ctx } = await context();
    const { one } = await import("./db/db");
    const row = await one<{ name: string | null }>(
      ctx.db,
      'SELECT name FROM "oauthClient" WHERE "clientId" = ?',
      [clientId],
    );
    return row?.name ?? null;
  });

/**
 * Makes `organizationId` the session's organization (the one its API requests act in), when the
 * signed-in person belongs to it. Pages under `/<organization>/…` call this on load.
 */
export const activateOrganization = createServerFn({ method: "POST" })
  .validator((organizationId: unknown) => {
    if (typeof organizationId !== "string" || !ID.test(organizationId))
      throw new Error("Not an organization");
    return organizationId;
  })
  .handler(async ({ data: organizationId }): Promise<boolean> => {
    const { ctx, request } = await context();
    const auth = await ctx.auth();
    const done = await auth.api
      .setActiveOrganization({ body: { organizationId }, headers: request.headers })
      .then(
        () => true,
        () => false,
      );
    return done;
  });

/**
 * The organizations (of the signed-in person) holding a project with this slug, for old
 * `/projects/<slug>` links.
 */
export const projectOrganizations = createServerFn({ method: "GET" })
  .validator((slug: unknown) => {
    if (typeof slug !== "string" || !/^[a-z0-9-]{1,80}$/.test(slug))
      throw new Error("Not a project");
    return slug;
  })
  .handler(async ({ data: slug }): Promise<string[]> => {
    const { ctx, request } = await context();
    const auth = await ctx.auth();
    const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
    if (!session) return [];
    const { all } = await import("./db/db");
    const rows = await all<{ slug: string }>(
      ctx.db,
      `SELECT o.slug FROM products p JOIN organization o ON o.id = p.org_id
       JOIN member m ON m."organizationId" = o.id AND m."userId" = ?
       WHERE p.slug = ? AND p.deleted_at IS NULL ORDER BY o.slug`,
      [session.user.id, slug],
    );
    return rows.map((row) => row.slug);
  });
