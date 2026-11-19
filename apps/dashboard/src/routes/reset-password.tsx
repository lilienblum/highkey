import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AuthError, AuthFrame, AuthNotice } from "@/components/auth/auth-frame";
import { SubmitButton, TextField, useAuthForm } from "@/components/auth/auth-fields";
import { Button } from "@/components/ui/button";
import { authPost } from "@/lib/auth-client";

// Reached from a reset email (through Better Auth, which adds `?token=` or `?error=`) or from a
// link the server admin handed over.
export const Route = createFileRoute("/reset-password")({
  head: () => ({ meta: [{ title: "Choose a new password · Highkey" }] }),
  component: ResetPassword,
});

function ResetPassword() {
  const params = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
  const token = params.get("token");
  const [done, setDone] = useState(false);
  const form = useAuthForm(async (data) => {
    const password = String(data.get("password") ?? "");
    if (password !== String(data.get("confirm") ?? "")) return "The two passwords don’t match.";
    const result = await authPost("/reset-password", { newPassword: password, token });
    if (!result.ok) return result.error;
    setDone(true);
  });
  if (done)
    return (
      <AuthFrame title="Password changed">
        <AuthNotice>
          <p>Your other sessions were signed out. Sign in with your new password.</p>
        </AuthNotice>
        <Button
          size="lg"
          className="auth-submit"
          nativeButton={false}
          role="link"
          render={<a href="/sign-in" />}
        >
          Sign in
        </Button>
      </AuthFrame>
    );
  if (!token || params.get("error"))
    return (
      <AuthFrame
        title="This link has expired"
        footer={
          <>
            Need a new one? <a href="/forgot-password">Reset your password</a>
          </>
        }
      >
        <AuthNotice>
          <p>Reset links work once, for a limited time. Ask for a new one.</p>
        </AuthNotice>
      </AuthFrame>
    );
  return (
    <AuthFrame title="Choose a new password">
      <form className="auth-form" method="post" onSubmit={form.onSubmit}>
        <AuthError>{form.error}</AuthError>
        <TextField
          name="password"
          label="New password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          autoFocus
          aside={<span className="auth-hint">10 characters or more</span>}
        />
        <TextField
          name="confirm"
          label="Repeat it"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
        />
        <SubmitButton pending={form.pending}>Change password</SubmitButton>
      </form>
    </AuthFrame>
  );
}
