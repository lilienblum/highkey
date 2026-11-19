import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AuthError, AuthFrame, AuthNotice } from "@/components/auth/auth-frame";
import { useHydrated } from "@/components/auth/auth-fields";
import { Button } from "@/components/ui/button";
import { authPost } from "@/lib/auth-client";

// Where a verification link lands (Better Auth adds `?error=` when the link is spent), and where
// a new account waits for its email.
export const Route = createFileRoute("/verify-email")({
  head: () => ({ meta: [{ title: "Verify your email · Highkey" }] }),
  component: VerifyEmail,
});

function VerifyEmail() {
  const { viewer } = Route.useRouteContext();
  const search = typeof window === "undefined" ? "" : window.location.search;
  const params = new URLSearchParams(search);
  const failed = params.get("error");
  const email = params.get("email") ?? "";
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Actions wait for hydration: a click before it would do nothing.
  const hydrated = useHydrated();
  const resend = async () => {
    setPending(true);
    setError(null);
    const result = await authPost("/send-verification-email", {
      email,
      callbackURL: "/verify-email",
    });
    setPending(false);
    if (result.ok) setSent(true);
    else setError(result.error);
  };
  if (viewer && !failed)
    return (
      <AuthFrame
        title="Email verified"
        lead={
          <>
            You’re signed in as <strong>{viewer.user.email}</strong>.
          </>
        }
      >
        <Button
          size="lg"
          className="auth-submit"
          nativeButton={false}
          role="link"
          render={<a href="/" />}
        >
          Open Highkey
        </Button>
      </AuthFrame>
    );
  return (
    <AuthFrame
      title={failed ? "This link has expired" : "Check your email"}
      footer={
        <>
          Verified on another device? <a href="/sign-in">Sign in</a>
        </>
      }
    >
      <AuthNotice>
        {failed ? (
          <p>Verification links work for an hour and only once. Sign in to get a new one.</p>
        ) : (
          <p>
            We sent a link to <strong>{email || "your email address"}</strong>. Open it to verify
            your address and sign in. It works for an hour.
          </p>
        )}
      </AuthNotice>
      <AuthError>{error}</AuthError>
      {email && !failed ? (
        <Button
          variant="outline"
          size="lg"
          disabled={pending || sent || !hydrated}
          onClick={resend}
        >
          {sent ? "Sent. Check your inbox" : "Send the link again"}
        </Button>
      ) : null}
    </AuthFrame>
  );
}
