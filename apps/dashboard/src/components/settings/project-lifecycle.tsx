import { useRouteContext } from "@tanstack/react-router";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ValueSelect } from "@/components/value-select";
import { api, type Product } from "@/lib/api";
import { useOrganizationSlug } from "@/lib/workspace-route";
import { oversees, useOrganizationRole } from "./settings-nav";

function Failure({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Alert variant="destructive" className="mt-4">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

/**
 * Moving a project to another organization and deleting it, for the organization's admins and
 * owners. Both leave this page: the project then lives elsewhere, or nowhere.
 */
export function ProjectLifecycle({ product }: { product: Product }) {
  const role = useOrganizationRole();
  if (!oversees(role)) return null;
  return (
    <div className="settings-grid">
      <MoveProject product={product} />
      <DeleteProject product={product} />
    </div>
  );
}

function MoveProject({ product }: { product: Product }) {
  const { viewer } = useRouteContext({ from: "__root__" });
  const current = useOrganizationSlug();
  // Only organizations where this person may bring a project in.
  const targets = (viewer?.organizations ?? []).filter(
    (org) => org.slug !== current && oversees(org.role),
  );
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const move = async () => {
    const org = targets.find((candidate) => candidate.id === target);
    if (!org) return;
    setBusy(true);
    setError(null);
    try {
      const moved = await api<Product>(`/products/${product.id}/move`, "POST", {
        organization: org.id,
      });
      // The other organization's address loads afresh, so every list and stream belongs to it.
      window.location.assign(`/${org.slug}/${moved.slug}/settings`);
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Move to another organization</CardTitle>
        <CardDescription>
          Its sources, keys, dashboards and views go with it. Only the other organization’s members
          see it afterwards.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {targets.length ? (
          <>
            <Field>
              <FieldLabel htmlFor="move-project-target">Move to</FieldLabel>
              <ValueSelect
                id="move-project-target"
                label="Move to"
                value={target}
                placeholder="Choose an organization"
                onValueChange={setTarget}
                options={targets.map((org) => [org.id, org.name])}
                disabled={busy}
              />
              <FieldDescription>Organizations where you’re an admin or owner.</FieldDescription>
            </Field>
            <Failure message={error} />
            <Button
              variant="outline"
              className="mt-6"
              disabled={busy || !target}
              aria-busy={busy}
              onClick={() => void move()}
            >
              {busy ? <Spinner data-icon="inline-start" aria-hidden="true" /> : null}
              Move project
            </Button>
          </>
        ) : (
          <p className="settings-muted">
            You can move it to an organization where you’re an admin or owner. You have none besides
            this one.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function DeleteProject({ product }: { product: Product }) {
  const current = useOrganizationSlug();
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/products/${product.id}`, "DELETE");
      window.location.assign(current ? `/${current}` : "/");
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Delete project</CardTitle>
        <CardDescription>
          It disappears from every page and its keys stop at once. An admin can restore it from
          Organization settings for 7 days; then its events and logs are wiped.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Field>
          <FieldLabel htmlFor="delete-project-confirm">Type “{product.name}” to confirm</FieldLabel>
          <Input
            id="delete-project-confirm"
            value={confirm}
            autoComplete="off"
            onChange={(event) => setConfirm(event.target.value)}
          />
        </Field>
        <Failure message={error} />
        <Button
          variant="destructive"
          className="mt-6"
          disabled={busy || confirm !== product.name}
          aria-busy={busy}
          onClick={() => void remove()}
        >
          {busy ? <Spinner data-icon="inline-start" aria-hidden="true" /> : null}
          Delete project
        </Button>
      </CardContent>
    </Card>
  );
}
