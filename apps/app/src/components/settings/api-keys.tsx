import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon } from "@hugeicons/core-free-icons";
import { type FormEvent, useState } from "react";
import { useWorkspace } from "@/components/app-shell";
import { ErrorState } from "@/components/shared";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PageLoading } from "../loading";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ValueSelect } from "@/components/value-select";
import { api } from "@/lib/api";
import {
  formatDate,
  oversees,
  OrganizationSettingsHeader,
  useOrganizationRole,
} from "./settings-nav";
import { useLoaded } from "./use-loaded";

interface ApiKey {
  project_id?: string;
  id: string;
  name: string | null;
  start: string | null;
  access: "read" | "write";
  user: { email: string };
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
}

const EXPIRY = [
  ["0", "Never"],
  ["30", "In 30 days"],
  ["90", "In 90 days"],
  ["365", "In a year"],
] as const;

export function ApiKeys() {
  const { products } = useWorkspace();
  const role = useOrganizationRole();
  const keys = useLoaded((signal) => api<ApiKey[]>("/keys", "GET", undefined, signal));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const revoke = async (key: ApiKey) => {
    setBusy(key.id);
    setError(null);
    try {
      await api(`/keys/${key.id}`, "DELETE");
      keys.reload();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <OrganizationSettingsHeader>
        <CreateKey readOnly={role === "viewer"} onCreated={keys.reload} />
      </OrganizationSettingsHeader>
      <div className="settings-stack">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <Card>
          <CardHeader>
            <CardTitle>{oversees(role) ? "Everyone’s keys" : "Your keys"}</CardTitle>
            <CardDescription>
              Send a key as <code>Authorization: Bearer hk_…</code>. Each may make 1,000 requests a
              minute.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {keys.error ? (
              <ErrorState message={keys.error} retry={keys.reload} />
            ) : !keys.data ? (
              <PageLoading label="Loading API keys" />
            ) : keys.data.length === 0 ? (
              <p className="settings-muted">No API keys yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Key</TableHead>
                    <TableHead>Access</TableHead>
                    <TableHead>Scope</TableHead>
                    {oversees(role) ? <TableHead>Owner</TableHead> : null}
                    <TableHead>Last used</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {keys.data.map((key) => (
                    <TableRow key={key.id}>
                      <TableCell>{key.name}</TableCell>
                      <TableCell>
                        <code>{key.start}…</code>
                      </TableCell>
                      <TableCell>
                        {key.access === "write" ? "Read and write" : "Read only"}
                      </TableCell>
                      <TableCell>
                        {key.project_id
                          ? (products.find((p) => p.id === key.project_id)?.name ??
                            "Selected project")
                          : "Organization"}
                      </TableCell>
                      {oversees(role) ? <TableCell>{key.user.email}</TableCell> : null}
                      <TableCell>{formatDate(key.last_used_at)}</TableCell>
                      <TableCell>{key.expires_at ? formatDate(key.expires_at) : "Never"}</TableCell>
                      <TableCell>
                        <div className="settings-row-actions">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy !== null}
                            aria-label={`Revoke ${key.name ?? "key"}`}
                            onClick={() => void revoke(key)}
                          >
                            Revoke
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function CreateKey({ readOnly, onCreated }: { readOnly: boolean; onCreated: () => void }) {
  const { products, product } = useWorkspace();
  const [scope, setScope] = useState(product?.id ?? "all");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [access, setAccess] = useState<"read" | "write">("read");
  const [expiry, setExpiry] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const reset = () => {
    setName("");
    setAccess("read");
    setExpiry("0");
    setScope(product?.id ?? "all");
    setError(null);
    setCreated(null);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const days = Number(expiry);
      const result = await api<{ key: string }>("/keys", "POST", {
        name: name.trim(),
        access,
        ...(scope !== "all" ? { project_id: scope } : {}),
        ...(days ? { expires_in_days: days } : {}),
      });
      setCreated(result.key);
      onCreated();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger render={<Button />}>
        <HugeiconsIcon
          icon={Add01Icon}
          strokeWidth={2}
          aria-hidden="true"
          data-icon="inline-start"
        />
        New API key
      </DialogTrigger>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{created ? "Copy your key now" : "New API key"}</DialogTitle>
          <DialogDescription>
            {created
              ? "It won’t be shown again. Keep it out of shared pages and repositories."
              : "It acts as you in this organization, and never beyond your role."}
          </DialogDescription>
        </DialogHeader>
        {created ? (
          <div className="settings-secret" role="status">
            <code>{created}</code>
            <CopyButton content={created} size="sm" aria-label="Copy the API key" />
          </div>
        ) : (
          <form onSubmit={submit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="key-name">Name</FieldLabel>
                <Input
                  id="key-name"
                  required
                  maxLength={32}
                  value={name}
                  placeholder="e.g. Wallboard"
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="key-access">Access</FieldLabel>
                <ValueSelect
                  id="key-access"
                  label="Access"
                  value={access}
                  options={
                    readOnly
                      ? [["read", "Read only"]]
                      : [
                          ["read", "Read only"],
                          ["write", "Read and write"],
                        ]
                  }
                  onValueChange={(value) => setAccess(value as "read" | "write")}
                />
                {readOnly ? (
                  <FieldDescription>Viewers can create read-only keys.</FieldDescription>
                ) : null}
              </Field>
              <Field>
                <FieldLabel htmlFor="key-scope">Project scope</FieldLabel>
                <ValueSelect
                  id="key-scope"
                  value={scope}
                  options={[
                    ...products.map((p) => [p.id, p.name] as const),
                    ["all", "All accessible projects"],
                  ]}
                  onValueChange={setScope}
                />
                <FieldDescription>
                  {scope === "all"
                    ? "Acts within your organization role."
                    : "Reads only this project. Write access also lets the token create and edit its dashboards."}
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="key-expiry">Expires</FieldLabel>
                <ValueSelect
                  id="key-expiry"
                  label="Expires"
                  value={expiry}
                  options={EXPIRY}
                  onValueChange={setExpiry}
                />
              </Field>
            </FieldGroup>
            {error ? (
              <Alert variant="destructive" className="mt-4">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <Button type="submit" className="mt-6" disabled={busy}>
              {busy ? <Spinner data-icon="inline-start" aria-hidden="true" /> : null}
              Create key
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
