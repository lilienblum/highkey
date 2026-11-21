import { createFileRoute, redirect } from "@tanstack/react-router";
import { AuthError, AuthFrame } from "@/components/auth/auth-frame";
import { SocialSignIn, SubmitButton, TextField, useAuthForm } from "@/components/auth/auth-fields";
import { afterSignIn, authPost, follow, verificationCallback } from "@/lib/auth-client";
import { getAuthSetup } from "@/server/viewer";

export const Route = createFileRoute("/sign-in")({
  beforeLoad: ({ context, location }) => {
    // Signed in already: go on, unless an agent's authorization is asking for a fresh sign-in.
    if (context.viewer && !location.searchStr.includes("sig="))
      throw redirect({ href: afterSignIn(location.searchStr) });
  },
  loader: async ({ location }) => {
    const setup = await getAuthSetup();
    // On a fresh server, the first account is made, not signed in to.
    if (setup.firstAccount) throw redirect({ href: `/sign-up${location.searchStr}` });
    return setup;
  },
  head: () => ({ meta: [{ title: "Sign in · Highkey" }] }),
  component: SignIn,
});

function SignIn() {
  const setup = Route.useLoaderData();
  const search = typeof window === "undefined" ? "" : window.location.search;
  const form = useAuthForm(async (data) => {
    const result = await authPost<{ twoFactorRedirect?: boolean }>("/sign-in/email", {
      email: String(data.get("email") ?? "").trim(),
      password: String(data.get("password") ?? ""),
      rememberMe: true,
      // An unverified address gets a new link, which returns here afterwards.
      callbackURL: verificationCallback(window.location.search),
    });
    if (!result.ok) return result.error;
    if (result.data?.twoFactorRedirect)
      window.location.assign(`/two-factor${window.location.search}`);
    else follow(result.data, afterSignIn(window.location.search));
  });
  return (
    <AuthFrame
      title="Sign in"
      footer={
        setup.signup === "open" ? (
          <>
            New to Highkey? <a href={`/sign-up${search}`}>Create an account</a>
          </>
        ) : (
          "This server requires an invitation to sign up. Open your invitation link to get started."
        )
      }
    >
      <SocialSignIn
        github={setup.social.github}
        google={setup.social.google}
        callbackURL={afterSignIn(search)}
        onError={form.setError}
      />
      <form className="auth-form" method="post" onSubmit={form.onSubmit}>
        <AuthError>{form.error}</AuthError>
        <TextField
          name="email"
          label="Email"
          type="email"
          autoComplete="email"
          required
          autoFocus
        />
        <TextField
          name="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          aside={<a href={`/forgot-password${search}`}>Forgot it?</a>}
        />
        <SubmitButton pending={form.pending}>Sign in</SubmitButton>
      </form>
    </AuthFrame>
  );
}
