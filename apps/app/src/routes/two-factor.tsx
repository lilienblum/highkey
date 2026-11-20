import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AuthError, AuthFrame } from "@/components/auth/auth-frame";
import { SubmitButton, TextField, useAuthForm } from "@/components/auth/auth-fields";
import { afterSignIn, authPost, follow } from "@/lib/auth-client";

// The second step of signing in, after the password, for accounts with two-factor codes.
export const Route = createFileRoute("/two-factor")({
  head: () => ({ meta: [{ title: "Two-factor code · Highkey" }] }),
  component: TwoFactor,
});

function TwoFactor() {
  const [backup, setBackup] = useState(false);
  const form = useAuthForm(async (data) => {
    const code = String(data.get("code") ?? "").replace(/\s+/g, "");
    const result = await authPost(
      backup ? "/two-factor/verify-backup-code" : "/two-factor/verify-totp",
      {
        code,
        trustDevice: data.get("trust") === "on",
      },
    );
    if (!result.ok)
      return result.status === 401 && !backup
        ? "That code isn’t right. Codes change every 30 seconds; try the current one."
        : result.error;
    follow(result.data, afterSignIn(window.location.search));
  });
  return (
    <AuthFrame
      title={backup ? "Use a backup code" : "Enter your code"}
      lead={
        backup
          ? "Each backup code works once."
          : "Open your authenticator app and enter the six-digit code for Highkey."
      }
      footer={
        <>
          {backup ? "Have your phone? " : "Lost your phone? "}
          <button
            type="button"
            className="auth-link auth-text-button"
            onClick={() => {
              setBackup(!backup);
              form.setError(null);
            }}
          >
            {backup ? "Use your authenticator" : "Use a backup code"}
          </button>
        </>
      }
    >
      <form
        className="auth-form"
        method="post"
        onSubmit={form.onSubmit}
        key={backup ? "backup" : "totp"}
      >
        <AuthError>{form.error}</AuthError>
        <TextField
          name="code"
          label={backup ? "Backup code" : "Code"}
          className={backup ? undefined : "auth-code"}
          inputMode={backup ? "text" : "numeric"}
          autoComplete="one-time-code"
          pattern={backup ? undefined : "[0-9 ]{6,7}"}
          maxLength={backup ? 32 : 7}
          required
          autoFocus
        />
        <label className="auth-check">
          <input type="checkbox" name="trust" />
          Trust this device for 30 days
        </label>
        <SubmitButton pending={form.pending}>Verify</SubmitButton>
      </form>
    </AuthFrame>
  );
}
