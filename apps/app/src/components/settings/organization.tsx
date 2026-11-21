import { useRouteContext } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { ErrorState } from "@/components/shared";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PageLoading } from "../loading";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { ValueSelect } from "@/components/value-select";
import { authAction, authGet } from "@/lib/auth-client";
import {
  oversees,
  OrganizationSettingsHeader,
  useOrganizationId,
  useOrganizationRole,
} from "./settings-nav";
import { DeletedProjects } from "./deleted-projects";
import { useLoaded } from "./use-loaded";

interface FullOrganization {
  id: string;
  name: string;
  slug: string;
  requireTwoFactor?: boolean | null;
  members: { id: string; role: string; userId: string; user: { name: string; email: string } }[];
}

function Failure({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Alert variant="destructive" className="mt-4">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

export function OrganizationSettings() {
  const role = useOrganizationRole();
  const organizationId = useOrganizationId();
  const org = useLoaded((signal) =>
    authGet<FullOrganization>(
      `/organization/get-full-organization?organizationId=${encodeURIComponent(organizationId)}`,
      signal,
    ),
  );
  return (
    <>
      <OrganizationSettingsHeader />
      <div className="settings-stack">
        {org.error ? (
          <ErrorState message={org.error} retry={org.reload} />
        ) : !org.data ? (
          <PageLoading label="Loading organization" />
        ) : (
          <>
            <General org={org.data} editable={oversees(role)} />
            {oversees(role) ? <DeletedProjects organizationSlug={org.data.slug} /> : null}
            {role === "owner" ? (
              <>
                <RequireTwoFactor org={org.data} onChanged={org.reload} />
                <TransferOwnership org={org.data} onDone={() => window.location.reload()} />
                <DeleteOrganization org={org.data} />
              </>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

function General({ org, editable }: { org: FullOrganization; editable: boolean }) {
  const [name, setName] = useState(org.name);
  const [slug, setSlug] = useState(org.slug);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await authAction("/organization/update", {
        organizationId: org.id,
        data: { name: name.trim(), ...(slug !== org.slug ? { slug: slug.trim() } : {}) },
      });
      // Its address may have changed: load everything afresh.
      window.location.reload();
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>General</CardTitle>
        <CardDescription>
          Project addresses start with the organization’s: <code>/{org.slug}/…</code>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="org-name">Name</FieldLabel>
              <Input
                id="org-name"
                required
                maxLength={80}
                value={name}
                disabled={!editable || busy}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="org-slug">Address</FieldLabel>
              <Input
                id="org-slug"
                required
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                maxLength={48}
                value={slug}
                disabled={!editable || busy}
                onChange={(event) => setSlug(event.target.value.toLowerCase())}
              />
              <FieldDescription>
                Lowercase letters, digits and dashes. Changing it breaks links to the old address.
              </FieldDescription>
            </Field>
          </FieldGroup>
          <Failure message={error} />
          {editable ? (
            <Button type="submit" className="mt-6" disabled={busy}>
              {busy ? <Spinner data-icon="inline-start" aria-hidden="true" /> : null}
              Save
            </Button>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}

function RequireTwoFactor({ org, onChanged }: { org: FullOrganization; onChanged: () => void }) {
  const { viewer } = useRouteContext({ from: "__root__" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = async (requireTwoFactor: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await authAction("/organization/update", {
        organizationId: org.id,
        data: { requireTwoFactor },
      });
      onChanged();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Two-factor codes</CardTitle>
        <CardDescription>
          When required, members without codes can’t reach this organization (in the browser, with
          API keys or through agents) until they turn them on.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Field orientation="horizontal">
          <div>
            <FieldLabel htmlFor="require-two-factor">Require two-factor codes</FieldLabel>
            {!viewer?.user.twoFactor ? (
              <FieldDescription>
                Turn on codes for your own account first, in Account.
              </FieldDescription>
            ) : null}
          </div>
          <Switch
            id="require-two-factor"
            checked={Boolean(org.requireTwoFactor)}
            disabled={busy || (!viewer?.user.twoFactor && !org.requireTwoFactor)}
            onCheckedChange={(checked) => void change(checked)}
          />
        </Field>
        <Failure message={error} />
      </CardContent>
    </Card>
  );
}

function TransferOwnership({ org, onDone }: { org: FullOrganization; onDone: () => void }) {
  const { viewer } = useRouteContext({ from: "__root__" });
  const others = org.members.filter((member) => member.userId !== viewer?.user.id);
  const mine = org.members.find((member) => member.userId === viewer?.user.id);
  const [target, setTarget] = useState(others[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!others.length || !mine) return null;
  const transfer = async () => {
    setBusy(true);
    setError(null);
    try {
      await authAction("/organization/update-member-role", {
        organizationId: org.id,
        memberId: target,
        role: "owner",
      });
      await authAction("/organization/update-member-role", {
        organizationId: org.id,
        memberId: mine.id,
        role: "admin",
      });
      onDone();
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  };
  const chosen = others.find((member) => member.id === target);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Transfer ownership</CardTitle>
        <CardDescription>The new owner gets everything; you stay on as an admin.</CardDescription>
      </CardHeader>
      <CardContent>
        <Field>
          <FieldLabel htmlFor="new-owner">New owner</FieldLabel>
          <ValueSelect
            id="new-owner"
            label="New owner"
            value={target}
            options={others.map((member) => [
              member.id,
              `${member.user.name} (${member.user.email})`,
            ])}
            onValueChange={setTarget}
          />
        </Field>
        <Failure message={error} />
        <AlertDialog>
          <AlertDialogTrigger
            render={<Button variant="outline" className="mt-6" disabled={busy} />}
          >
            Transfer ownership
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Make {chosen?.user.name} the owner?</AlertDialogTitle>
              <AlertDialogDescription>
                You become an admin. Only an owner can give ownership back.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => void transfer()}>Transfer</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

function DeleteOrganization({ org }: { org: FullOrganization }) {
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await authAction("/organization/delete", { organizationId: org.id });
      window.location.assign("/");
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Delete organization</CardTitle>
        <CardDescription>
          Only once it has no projects (deleted ones count until they are wiped, 7 days later). Its
          members, invitations, API keys and agent connections go with it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Field>
          <FieldLabel htmlFor="delete-org-confirm">Type “{org.name}” to confirm</FieldLabel>
          <Input
            id="delete-org-confirm"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </Field>
        <Failure message={error} />
        <Button
          variant="destructive"
          className="mt-6"
          disabled={busy || confirm !== org.name}
          onClick={() => void remove()}
        >
          {busy ? <Spinner data-icon="inline-start" aria-hidden="true" /> : null}
          Delete organization
        </Button>
      </CardContent>
    </Card>
  );
}
