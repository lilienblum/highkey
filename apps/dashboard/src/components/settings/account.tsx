import { useRouteContext } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { PageHeader } from "@/components/app-shell";
import { ErrorState } from "@/components/shared";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { authAction, authGet } from "@/lib/auth-client";
import { formatDate, SettingsNav } from "./settings-nav";
import { useLoaded } from "./use-loaded";

function Failure({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Alert variant="destructive" className="mt-4">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

function Done({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="settings-muted mt-4" role="status">
      {message}
    </p>
  );
}

/** A small form: runs `action` with the form's values, shows its failure or `done`. */
function useAction(action: (form: FormData) => Promise<string | undefined>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const message = await action(new FormData(form));
      setDone(message ?? null);
      form.reset();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, done, onSubmit, setError };
}

export function Account() {
  const { viewer } = useRouteContext({ from: "__root__" });
  if (!viewer) return null;
  // The open organization requires codes this person has not turned on: it opens once they do.
  const required = viewer.user.twoFactor
    ? undefined
    : viewer.organizations.find(
        (org) => org.id === viewer.activeOrganizationId && org.requireTwoFactor,
      );
  return (
    <>
      <SettingsNav />
      <PageHeader title="Account" description={`Signed in as ${viewer.user.email}.`} />
      <div className="settings-stack">
        {required ? (
          <Alert>
            <AlertDescription>
              {required.name} requires two-factor codes. Turn them on below to open its projects.
            </AlertDescription>
          </Alert>
        ) : null}
        <Profile name={viewer.user.name} />
        <Password />
        <TwoFactor enabled={viewer.user.twoFactor} />
        <Sessions />
        <DeleteAccount />
      </div>
    </>
  );
}

function Profile({ name }: { name: string }) {
  const form = useAction(async (data) => {
    await authAction("/update-user", { name: String(data.get("name") ?? "").trim() });
    return "Saved.";
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>Your name, as members of your organizations see it.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.onSubmit}>
          <Field>
            <FieldLabel htmlFor="account-name">Name</FieldLabel>
            <Input id="account-name" name="name" required maxLength={80} defaultValue={name} />
          </Field>
          <Failure message={form.error} />
          <Done message={form.done} />
          <Button type="submit" className="mt-6" disabled={form.busy}>
            Save
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function Password() {
  const form = useAction(async (data) => {
    const next = String(data.get("new") ?? "");
    if (next !== String(data.get("repeat") ?? ""))
      throw new Error("The new passwords don’t match.");
    await authAction("/change-password", {
      currentPassword: String(data.get("current") ?? ""),
      newPassword: next,
      revokeOtherSessions: true,
    });
    return "Password changed. Your other sessions were signed out.";
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>At least 10 characters. Other sessions are signed out.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.onSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="password-current">Current password</FieldLabel>
              <Input
                id="password-current"
                name="current"
                type="password"
                autoComplete="current-password"
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="password-new">New password</FieldLabel>
              <Input
                id="password-new"
                name="new"
                type="password"
                autoComplete="new-password"
                minLength={10}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="password-repeat">Repeat it</FieldLabel>
              <Input
                id="password-repeat"
                name="repeat"
                type="password"
                autoComplete="new-password"
                minLength={10}
                required
              />
            </Field>
          </FieldGroup>
          <Failure message={form.error} />
          <Done message={form.done} />
          <Button type="submit" className="mt-6" disabled={form.busy}>
            Change password
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/** The base32 key inside an authenticator URI, grouped in fours for typing. */
function setupKey(uri: string): string {
  const secret = new URL(uri).searchParams.get("secret") ?? "";
  return secret.match(/.{1,4}/g)?.join(" ") ?? secret;
}

function TwoFactor({ enabled }: { enabled: boolean }) {
  const [setup, setSetup] = useState<{ uri: string; backupCodes: string[] } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const start = useAction(async (data) => {
    const result = await authAction<{ totpURI: string; backupCodes: string[] }>(
      "/two-factor/enable",
      { password: String(data.get("password") ?? "") },
    );
    setSetup({ uri: result.totpURI, backupCodes: result.backupCodes });
    return undefined;
  });
  const confirm = useAction(async (data) => {
    await authAction("/two-factor/verify-totp", {
      code: String(data.get("code") ?? "").replace(/\s+/g, ""),
    });
    // Turning codes on starts a new session: load everything with it.
    window.location.reload();
    return undefined;
  });
  const off = useAction(async (data) => {
    await authAction("/two-factor/disable", { password: String(data.get("password") ?? "") });
    window.location.reload();
    return undefined;
  });
  const regenerate = useAction(async (data) => {
    const result = await authAction<{ backupCodes: string[] }>(
      "/two-factor/generate-backup-codes",
      {
        password: String(data.get("password") ?? ""),
      },
    );
    setCodes(result.backupCodes);
    return "New backup codes; the old ones no longer work.";
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Two-factor codes</CardTitle>
        <CardDescription>
          {enabled
            ? "On. Signing in asks for a code from your authenticator app."
            : "Signing in also asks for a six-digit code from an authenticator app."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {enabled ? (
          <div className="settings-stack">
            <form onSubmit={regenerate.onSubmit}>
              <Field>
                <FieldLabel htmlFor="codes-password">Password</FieldLabel>
                <Input id="codes-password" name="password" type="password" required />
              </Field>
              <Failure message={regenerate.error} />
              <Done message={regenerate.done} />
              {codes ? <BackupCodes codes={codes} /> : null}
              <Button type="submit" variant="outline" className="mt-4" disabled={regenerate.busy}>
                New backup codes
              </Button>
            </form>
            <form onSubmit={off.onSubmit}>
              <Field>
                <FieldLabel htmlFor="off-password">Password</FieldLabel>
                <Input id="off-password" name="password" type="password" required />
              </Field>
              <Failure message={off.error} />
              <Button type="submit" variant="outline" className="mt-4" disabled={off.busy}>
                Turn off two-factor codes
              </Button>
            </form>
          </div>
        ) : setup ? (
          <form onSubmit={confirm.onSubmit}>
            <FieldGroup>
              <Field>
                <FieldLabel>Setup key</FieldLabel>
                <div className="settings-secret">
                  <code data-testid="totp-setup-key">{setupKey(setup.uri)}</code>
                  <CopyButton
                    content={setup.uri}
                    size="sm"
                    aria-label="Copy the authenticator link"
                  />
                </div>
                <FieldDescription>
                  Add an account in your authenticator app with this key (time based, six digits),
                  or open the copied link on a device that has the app.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel>Backup codes</FieldLabel>
                <BackupCodes codes={setup.backupCodes} />
                <FieldDescription>
                  Keep them somewhere safe; each signs you in once without your phone.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="confirm-code">Code from the app</FieldLabel>
                <Input
                  id="confirm-code"
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9 ]{6,7}"
                  required
                />
              </Field>
            </FieldGroup>
            <Failure message={confirm.error} />
            <Button type="submit" className="mt-6" disabled={confirm.busy}>
              {confirm.busy ? <Spinner data-icon="inline-start" aria-hidden="true" /> : null}
              Turn on
            </Button>
          </form>
        ) : (
          <form onSubmit={start.onSubmit}>
            <Field>
              <FieldLabel htmlFor="two-factor-password">Password</FieldLabel>
              <Input
                id="two-factor-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </Field>
            <Failure message={start.error} />
            <Button type="submit" className="mt-6" disabled={start.busy}>
              Set up two-factor codes
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function BackupCodes({ codes }: { codes: string[] }) {
  return (
    <div className="settings-stack">
      <ul className="settings-codes">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <CopyButton content={codes.join("\n")} size="sm">
        Copy backup codes
      </CopyButton>
    </div>
  );
}

interface Session {
  id: string;
  token: string;
  userAgent?: string | null;
  ipAddress?: string | null;
  createdAt: string;
  updatedAt?: string;
}

function browserOf(agent: string | null | undefined): string {
  if (!agent) return "Unknown browser";
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /Firefox\//.test(agent)
      ? "Firefox"
      : /Chrome\//.test(agent)
        ? "Chrome"
        : /Safari\//.test(agent)
          ? "Safari"
          : "Browser";
  const system = /Mac OS X|Macintosh/.test(agent)
    ? "macOS"
    : /Windows/.test(agent)
      ? "Windows"
      : /Android/.test(agent)
        ? "Android"
        : /iPhone|iPad/.test(agent)
          ? "iOS"
          : /Linux/.test(agent)
            ? "Linux"
            : "";
  return system ? `${browser} on ${system}` : browser;
}

function Sessions() {
  const sessions = useLoaded(async (signal) => {
    const [list, current] = await Promise.all([
      authGet<Session[]>("/list-sessions", signal),
      authGet<{ session: { token: string } }>("/get-session", signal),
    ]);
    return { list, current: current.session.token };
  });
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
      sessions.reload();
    } catch (failure) {
      setError((failure as Error).message);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sessions</CardTitle>
        <CardDescription>Where you’re signed in. A session lasts 7 days of disuse.</CardDescription>
      </CardHeader>
      <CardContent>
        {sessions.error ? (
          <ErrorState message={sessions.error} retry={sessions.reload} />
        ) : !sessions.data ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Browser</TableHead>
                  <TableHead>Address</TableHead>
                  <TableHead>Signed in</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.data.list.map((session) => (
                  <TableRow key={session.id}>
                    <TableCell>{browserOf(session.userAgent)}</TableCell>
                    <TableCell>{session.ipAddress || "—"}</TableCell>
                    <TableCell>{formatDate(session.createdAt)}</TableCell>
                    <TableCell>
                      <div className="settings-row-actions">
                        {session.token === sessions.data?.current ? (
                          <span className="settings-muted">This session</span>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              void run(() =>
                                authAction("/revoke-session", { token: session.token }),
                              )
                            }
                          >
                            Sign out
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Failure message={error} />
            {sessions.data.list.length > 1 ? (
              <Button
                variant="outline"
                className="mt-4"
                onClick={() => void run(() => authAction("/revoke-other-sessions"))}
              >
                Sign out everywhere else
              </Button>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function DeleteAccount() {
  const form = useAction(async (data) => {
    await authAction("/delete-user", { password: String(data.get("password") ?? "") });
    window.location.assign("/sign-in");
    return undefined;
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Delete account</CardTitle>
        <CardDescription>
          Organizations where you are the only member go with you. If you are the only owner of one
          with other members, transfer ownership first.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.onSubmit}>
          <Field>
            <FieldLabel htmlFor="delete-password">Password</FieldLabel>
            <Input id="delete-password" name="password" type="password" required />
          </Field>
          <Failure message={form.error} />
          <Button type="submit" variant="destructive" className="mt-6" disabled={form.busy}>
            Delete my account
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
