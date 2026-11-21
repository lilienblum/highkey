/** An unset policy allows registration. Unknown explicit values keep sign-up restricted. */
export function signupPolicy(value: string | undefined): "open" | "invite" {
  return value === undefined || value === "open" ? "open" : "invite";
}
