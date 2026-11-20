// Which pages are account screens. Public ones need no session (signing in, signing up, the Join
// page an invitation links to); the agent-authorization steps need one but share the frame.

const PUBLIC = [
  "/sign-in",
  "/sign-up",
  "/verify-email",
  "/forgot-password",
  "/reset-password",
  "/two-factor",
];
const SIGNED_IN = ["/select-organization", "/consent", "/welcome", "/new"];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC.includes(pathname) || pathname.startsWith("/join/");
}

/** Pages drawn in the account frame instead of the workspace. */
export function isAccountScreen(pathname: string): boolean {
  return isPublicPath(pathname) || SIGNED_IN.includes(pathname);
}

/**
 * First path segments Highkey's own pages use. Organization addresses (`/<slug>/…`) never take
 * them, or the page would hide the organization.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "events",
  "logs",
  "settings",
  "explore",
  "dashboards",
  "projects",
  "admin",
  "account",
  "api",
  "mcp",
  "assets",
  "tracker",
  "llms",
  "health",
  "favicon",
  "well-known",
  "highkey",
  "sign-in",
  "sign-up",
  "sign-out",
  "verify-email",
  "forgot-password",
  "reset-password",
  "two-factor",
  "join",
  "select-organization",
  "consent",
  "welcome",
  "new",
  "organizations",
]);

/** Account settings open without a usable organization: two-factor codes are turned on there. */
export const ACCOUNT_SETTINGS = "/settings/account";

/** Where an organization without projects starts: creating its first one. */
export const NEW_PROJECT = "/new";

/** Pages about the organization or the person, not a project: they open without one. */
const ORGANIZATION_PAGES = [
  "/settings/organization",
  "/settings/members",
  "/settings/keys",
  "/settings/agents",
  ACCOUNT_SETTINGS,
  "/admin",
];

/** Pages that act in an open organization (the workspace, and creating a project in it). */
export function needsOrganization(pathname: string): boolean {
  return (!isAccountScreen(pathname) || pathname === NEW_PROJECT) && pathname !== ACCOUNT_SETTINGS;
}

/** Workspace pages that show a project; with none in the organization, they create one first. */
export function needsProject(pathname: string): boolean {
  return !isAccountScreen(pathname) && !ORGANIZATION_PAGES.includes(pathname);
}
