import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AuthError, AuthFrame, AuthNotice } from "@/components/auth/auth-frame";
import { SubmitButton, TextField, useAuthForm } from "@/components/auth/auth-fields";
import { authPost } from "@/lib/auth-client";
import { getAuthSetup } from "@/server/viewer";

export const Route = createFileRoute("/forgot-password")({
  loader: () => getAuthSetup(),
  head: () => ({ meta: [{ title: "Reset your password · Highkey" }] }),
  component: ForgotPassword,
});

function ForgotPassword() {
  const setup = Route.useLoaderData();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const form = useAuthForm(async (data) => {
    const email = String(data.get("email") ?? "").trim();
    const result = await authPost("/request-password-reset", {
      email,
      redirectTo: "/reset-password",
    });
    if (!result.ok) return result.error;
    setSentTo(email);
  });
  const back = (
    <>
      Remembered it? <a href="/sign-in">Sign in</a>
    </>
  );
  // Without email, the server admin hands over a one-time reset link.
  if (!setup.email)
    return (
      <AuthFrame title="Reset your password" footer={back}>
        <AuthNotice>
          <p>This server doesn’t send email. Ask your server admin for a password reset link.</p>
        </AuthNotice>
      </AuthFrame>
    );
  if (sentTo)
    return (
      <AuthFrame title="Check your email" footer={back}>
        <AuthNotice>
          <p>
            If an account uses <strong>{sentTo}</strong>, a reset link is on its way. It works for
            an hour.
          </p>
        </AuthNotice>
      </AuthFrame>
    );
  return (
    <AuthFrame
      title="Reset your password"
      lead="We’ll email you a link to choose a new one."
      footer={back}
    >
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
        <SubmitButton pending={form.pending}>Send reset link</SubmitButton>
      </form>
    </AuthFrame>
  );
}
