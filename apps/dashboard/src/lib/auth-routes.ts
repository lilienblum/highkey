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
const SIGNED_IN = ["/select-organization", "/consent"];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC.includes(pathname) || pathname.startsWith("/join/");
}

/** Pages drawn in the account frame instead of the workspace. */
export function isAccountScreen(pathname: string): boolean {
  return isPublicPath(pathname) || SIGNED_IN.includes(pathname);
}
