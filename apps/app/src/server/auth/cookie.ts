// Better Auth's session cookie name: `__Secure-` prefixed when Highkey is served over HTTPS. The
// live channel reads this cookie by name, so it must match what Better Auth sets.
export function sessionCookieName(publicUrl: string): string {
  return `${new URL(publicUrl).protocol === "https:" ? "__Secure-" : ""}better-auth.session_token`;
}
