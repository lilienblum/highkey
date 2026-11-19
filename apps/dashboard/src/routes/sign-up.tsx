import { createFileRoute, redirect } from "@tanstack/react-router";
import { AuthError, AuthFrame } from "@/components/auth/auth-frame";
import { SocialSignIn, SubmitButton, TextField, useAuthForm } from "@/components/auth/auth-fields";
import { afterSignIn, authPost, follow, verificationCallback } from "@/lib/auth-client";
import { getAuthSetup } from "@/server/viewer";

export const Route = createFileRoute("/sign-up")({
  beforeLoad: ({ context, location }) => {
    if (context.viewer) throw redirect({ href: afterSignIn(location.searchStr) });
  },
  loader: () => getAuthSetup(),
  head: () => ({ meta: [{ title: "Create your account · Highkey" }] }),
  component: SignUp,
});

function SignUp() {
  const setup = Route.useLoaderData();
  const search = typeof window === "undefined" ? "" : window.location.search;
  const invited = new URLSearchParams(search).get("email") ?? "";
  const form = useAuthForm(async (data) => {
    const email = String(data.get("email") ?? "").trim();
    const result = await authPost<{ token?: string | null }>("/sign-up/email", {
      name: String(data.get("name") ?? "").trim(),
      email,
      password: String(data.get("password") ?? ""),
      callbackURL: verificationCallback(window.location.search),
    });
    if (!result.ok) return result.error;
    // With email configured, the account waits for its address to be verified; the link (and a
    // new one sent from the waiting page) returns to where the account was going.
    if (setup.email && !result.data?.token) {
      const going = new URLSearchParams(verificationCallback(window.location.search).split("?")[1]);
      going.set("email", email);
      window.location.assign(`/verify-email?${going}`);
    } else follow(result.data, afterSignIn(window.location.search));
  });
  const title = setup.firstAccount ? "Set up Highkey" : "Create your account";
  const lead = setup.firstAccount
    ? "This first account administers the server and owns its first organization."
    : invited
      ? undefined
      : "Your account comes with an organization of its own for your projects.";
  return (
    <AuthFrame
      title={title}
      lead={lead}
      footer={
        setup.firstAccount ? undefined : (
          <>
            Already have an account? <a href={`/sign-in${search}`}>Sign in</a>
          </>
        )
      }
    >
      {setup.firstAccount ? null : (
        <SocialSignIn
          github={setup.social.github}
          google={setup.social.google}
          callbackURL={afterSignIn(search)}
          onError={form.setError}
        />
      )}
      <form className="auth-form" method="post" onSubmit={form.onSubmit}>
        <AuthError>{form.error}</AuthError>
        <TextField name="name" label="Name" autoComplete="name" required maxLength={80} autoFocus />
        <TextField
          name="email"
          label="Email"
          type="email"
          autoComplete="email"
          required
          defaultValue={invited}
          readOnly={Boolean(invited)}
        />
        <TextField
          name="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          aside={<span className="auth-hint">10 characters or more</span>}
        />
        <SubmitButton pending={form.pending}>
          {setup.firstAccount ? "Create the first account" : "Create account"}
        </SubmitButton>
      </form>
    </AuthFrame>
  );
}
