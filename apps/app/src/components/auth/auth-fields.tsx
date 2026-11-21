import { HugeiconsIcon } from "@hugeicons/react";
import { GithubIcon, GoogleIcon } from "@hugeicons/core-free-icons";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { authPost, follow } from "@/lib/auth-client";

/** A form whose submit runs `action`; it tracks the pending state and the error to show. */
export function useAuthForm(action: (form: FormData) => Promise<string | null | undefined>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    const failure = await action(new FormData(event.currentTarget));
    // A success navigates away; only a failure leaves the form to use again.
    if (failure) {
      setError(failure);
      setPending(false);
    }
  };
  return { pending, error, setError, onSubmit };
}

/** Whether the page has hydrated, so its handlers (not the browser's own form submit) run. */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}

/**
 * The form's submit. Until the page is interactive it stays disabled, so a quick click never
 * makes the browser submit the form itself (with the password in a request of its own).
 */
export function SubmitButton({
  pending,
  children,
  compact = false,
}: {
  pending: boolean;
  children: string;
  compact?: boolean;
}) {
  const hydrated = useHydrated();
  return (
    <Button
      type="submit"
      size={compact ? "default" : "lg"}
      className={compact ? "mt-1 self-start" : "auth-submit"}
      disabled={pending || !hydrated}
      aria-busy={pending}
    >
      {pending ? <Spinner aria-hidden="true" /> : null}
      {children}
    </Button>
  );
}

export function TextField({
  name,
  label,
  aside,
  hint,
  ...input
}: {
  name: string;
  label: string;
  aside?: React.ReactNode;
  hint?: React.ReactNode;
} & React.ComponentProps<"input">) {
  const id = `auth-${name}`;
  return (
    <Field>
      <div className="auth-field-row">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {aside}
      </div>
      <Input id={id} name={name} aria-describedby={hint ? `${id}-hint` : undefined} {...input} />
      {hint ? <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription> : null}
    </Field>
  );
}

/** GitHub and Google, when the server has them configured. */
export function SocialSignIn({
  github,
  google,
  callbackURL,
  onError,
}: {
  github: boolean;
  google: boolean;
  callbackURL: string;
  onError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const hydrated = useHydrated();
  if (!github && !google) return null;
  const start = async (provider: "github" | "google") => {
    setBusy(provider);
    onError(null);
    const result = await authPost("/sign-in/social", { provider, callbackURL });
    if (!result.ok) {
      onError(result.error);
      setBusy(null);
      return;
    }
    follow(result.data, callbackURL);
  };
  return (
    <>
      <div className="auth-social">
        {github ? (
          <Button
            variant="outline"
            size="lg"
            disabled={busy !== null || !hydrated}
            onClick={() => start("github")}
          >
            <HugeiconsIcon icon={GithubIcon} strokeWidth={2} aria-hidden="true" />
            Continue with GitHub
          </Button>
        ) : null}
        {google ? (
          <Button
            variant="outline"
            size="lg"
            disabled={busy !== null || !hydrated}
            onClick={() => start("google")}
          >
            <HugeiconsIcon icon={GoogleIcon} strokeWidth={2} aria-hidden="true" />
            Continue with Google
          </Button>
        ) : null}
      </div>
      <p className="auth-divider">or with your email</p>
    </>
  );
}
