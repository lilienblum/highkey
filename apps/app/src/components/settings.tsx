import { AllowedOriginsField, KeyOriginsEditor, parseOrigins } from "./key-origins";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  Delete02Icon,
  Key01Icon,
  SecurityCheckIcon,
  SourceCodeIcon,
  Tick01Icon,
} from "@hugeicons/core-free-icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Spinner } from "@/components/ui/spinner";
import { PageLoading } from "./loading";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { ValueSelect } from "./value-select";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { api, type Product } from "@/lib/api";
import { PageHeader, useWorkspace } from "./app-shell";
import { ProjectLifecycle } from "./settings/project-lifecycle";
import { RevenueSettings } from "./settings/revenue";
import { Activation } from "./activation";
import { ErrorState } from "./shared";
import { ReferenceSettings } from "./chart-references";
import { CollectionExclusions } from "./collection-exclusions";
import { ExportSettings } from "./export-settings";
import { Notifications } from "./notifications";
import { SourceSettings } from "./source-settings";
import { SourceIcon } from "./source-icon";
import { ProjectWebsites, parseWebsites, websiteList } from "./project-websites";
import { sourceWebsite } from "@/lib/report-link";
import { LogSettings } from "./log-settings";
import { type Integration, IntegrationTabs } from "./integration-guide";
type KeyInfo = {
  kind: "public" | "server";
  allowed_origins: string[];
  source_id: string;
  id: string;
  label: string;
  prefix: string;
  created_at: string;
  revoked: boolean;
};
function ProductFields({
  value,
  onChange,
  prefix,
  disabled = false,
}: {
  value: { name: string; retention_days: number; websites: string };
  onChange: (v: typeof value) => void;
  prefix: string;
  disabled?: boolean;
}) {
  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor={`${prefix}-name`}>Project name</FieldLabel>
        <Input
          id={`${prefix}-name`}
          disabled={disabled}
          value={value.name}
          maxLength={80}
          required
          placeholder="e.g. Orbit"
          onChange={(e) => onChange({ ...value, name: e.target.value })}
        />
      </Field>
      <ProjectWebsites
        id={`${prefix}-websites`}
        value={value.websites}
        disabled={disabled}
        onChange={(e) => onChange({ ...value, websites: e.target.value })}
      />
      <Field>
        <FieldLabel htmlFor={`${prefix}-retention`}>Retention (days)</FieldLabel>
        <Input
          id={`${prefix}-retention`}
          disabled={disabled}
          type="number"
          min={1}
          max={3650}
          required
          value={value.retention_days}
          onChange={(e) => onChange({ ...value, retention_days: Number(e.target.value) })}
        />
        <FieldDescription>
          Events older than this are removed automatically. Applies to all sources in this project.
        </FieldDescription>
      </Field>
    </FieldGroup>
  );
}
export function Settings() {
  const { product, reload, sourceId, source } = useWorkspace();
  const site = sourceWebsite(source);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ name: "", retention_days: 365, websites: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [createdProduct, setCreatedProduct] = useState<Product>();
  async function create(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    let saved = createdProduct;
    try {
      saved ??= await api<Product>("/products", "POST", {
        name: draft.name,
        retention_days: draft.retention_days,
        website_urls: parseWebsites(draft.websites),
      });
      setCreatedProduct(saved);
      await reload(saved.id);
      setOpen(false);
      setDraft({ name: "", retention_days: 365, websites: "" });
      setCreatedProduct(undefined);
    } catch (e) {
      setError(
        saved
          ? `Project created. Could not refresh the workspace. ${(e as Error).message}`
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        title="Project settings"
        description="Manage collection, ingestion keys, and retention."
      >
        <Dialog
          open={open}
          onOpenChange={(value) => {
            if (!busy) setOpen(value);
          }}
        >
          <DialogTrigger render={<Button />}>
            <HugeiconsIcon
              icon={Add01Icon}
              strokeWidth={2}
              aria-hidden="true"
              data-icon="inline-start"
            />
            New project
          </DialogTrigger>
          <DialogContent showCloseButton={!busy}>
            <DialogHeader>
              <DialogTitle>Create a project</DialogTitle>
              <DialogDescription>
                A separate space for events and ingestion keys. No URL required.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={create} aria-busy={busy}>
              <ProductFields
                value={draft}
                onChange={setDraft}
                prefix="create"
                disabled={busy || !!createdProduct}
              />
              {error && <ErrorState message={error} />}
              <Button type="submit" disabled={busy} className="mt-6">
                {busy && <Spinner data-icon="inline-start" aria-hidden="true" />}
                {busy
                  ? createdProduct
                    ? "Loading project…"
                    : "Creating…"
                  : createdProduct
                    ? "Retry loading project"
                    : "Create project"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </PageHeader>
      {product ? (
        <>
          <ProductSettings key={`${product.id}:${sourceId ?? ""}`} product={product} />
          <ReferenceSettings key={`references-${product.id}`} />
          <CollectionExclusions key={`exclusions-${product.id}`} id={product.id} />
          <ExportSettings key={`export-${product.id}`} id={product.id} />
          <Notifications key={`notifications-${product.id}`} id={product.id} slug={product.slug} />
          <Activation
            key={`activation-${product.id}`}
            id={product.id}
            source={sourceId}
            website={site ?? product.website_url}
            websiteSource={site ? sourceId : undefined}
          />
          <LogSettings
            key={`logs-${product.id}:${sourceId ?? ""}`}
            product={product}
            sourceId={sourceId}
          />
          <ProjectLifecycle key={`lifecycle-${product.id}`} product={product} />
        </>
      ) : (
        <Alert>
          <AlertTitle>Create your first project</AlertTitle>
          <AlertDescription>
            Use New project to connect a website, CLI, or any other application.
          </AlertDescription>
        </Alert>
      )}
    </>
  );
}
function ProductSettings({ product }: { product: Product }) {
  const { reload, sourceId } = useWorkspace();
  const [keySourceId, setKeySourceId] = useState(
    sourceId ?? product.sources?.[0]?.id ?? product.id,
  );
  const keySource = product.sources?.find((source) => source.id === keySourceId);
  const [draft, setDraft] = useState({
    name: product.name,
    websites: websiteList(product).join("\n"),
    retention_days: product.retention_days,
  });
  const [keyState, setKeyState] = useState<
    | { status: "loading" }
    | { status: "ready"; keys: KeyInfo[] }
    | { status: "error"; message: string }
  >({ status: "loading" });
  const [label, setLabel] = useState("");
  const [allowedOrigins, setAllowedOrigins] = useState("");
  const [keyKind, setKeyKind] = useState("public");
  const [createdKey, setCreatedKey] = useState<{ id: string; key: string } | null>(null);
  const newKey = createdKey?.key ?? "";
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<"save" | "create-key" | "revoke" | null>(null);
  const busy = pending !== null;
  const [integration, setIntegration] = useState<Integration>("browser");
  const [revoke, setRevoke] = useState<KeyInfo | null>(null);
  const [revokeError, setRevokeError] = useState("");
  const loadKeys = useCallback(
    async (signal?: AbortSignal, savedMessage = "") => {
      setKeyState({ status: "loading" });
      try {
        const keys = await api<KeyInfo[]>(`/products/${product.id}/keys`, "GET", undefined, signal);
        if (!signal?.aborted) setKeyState({ status: "ready", keys });
      } catch (e) {
        if (!signal?.aborted) {
          setKeyState({ status: "error", message: `${savedMessage}${(e as Error).message}` });
        }
      }
    },
    [product.id],
  );
  useEffect(() => {
    const controller = new AbortController();
    void loadKeys(controller.signal);
    return () => controller.abort();
  }, [loadKeys]);
  async function action(kind: NonNullable<typeof pending>, task: () => Promise<void>) {
    if (busy) return;
    setPending(kind);
    if (kind === "revoke") setRevokeError("");
    setError("");
    setNotice("");
    try {
      await task();
    } catch (e) {
      if (kind === "revoke") setRevokeError((e as Error).message);
      else setError((e as Error).message);
    } finally {
      setPending(null);
    }
  }
  return (
    <>
      {error && !revoke && <ErrorState message={error} />}
      {notice && (
        <Alert>
          <HugeiconsIcon icon={Tick01Icon} strokeWidth={2} aria-hidden="true" />
          <AlertTitle>{notice}</AlertTitle>
        </Alert>
      )}
      <SourceSettings product={product} />
      <RevenueSettings projectId={product.id} />
      <div className="settings-grid">
        <Card>
          <CardHeader>
            <CardTitle>Project details</CardTitle>
            <CardDescription>One name and retention policy for all your sources.</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action("save", async () => {
                  const saved = await api<Product>(`/products/${product.id}`, "PATCH", {
                    name: draft.name,
                    retention_days: draft.retention_days,
                    website_urls: parseWebsites(draft.websites),
                  });
                  setDraft({
                    name: saved.name,
                    retention_days: saved.retention_days,
                    websites: websiteList(saved).join("\n"),
                  });
                  setNotice("Project changes saved.");
                  try {
                    await reload();
                  } catch (e) {
                    setError(
                      `Changes saved. Could not refresh the workspace. ${(e as Error).message}`,
                    );
                  }
                });
              }}
            >
              <ProductFields value={draft} onChange={setDraft} prefix="edit" disabled={busy} />
              {product.website_url && (
                <p className="quiet mt-3">
                  {product.favicon_version
                    ? "Website icon saved."
                    : "No supported favicon found. Using the default project icon; save again to retry."}
                </p>
              )}
              <div className="settings-save">
                <code title={product.id}>{product.id.slice(0, 8)}…</code>
                <Button type="submit" disabled={busy} aria-busy={pending === "save"}>
                  {pending === "save" && <Spinner data-icon="inline-start" aria-hidden="true" />}
                  {pending === "save" ? "Saving…" : "Save changes"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div className="card-heading">
              <div>
                <CardTitle>Ingestion keys</CardTitle>
                <CardDescription>
                  Write-only keys bound to one source. The key determines where events arrive.
                </CardDescription>
              </div>
              <HugeiconsIcon
                icon={Key01Icon}
                strokeWidth={2}
                aria-hidden="true"
                className="quiet-icon"
              />
            </div>
          </CardHeader>
          <CardContent>
            {newKey && (
              <Alert className="mb-5">
                <HugeiconsIcon icon={SecurityCheckIcon} strokeWidth={2} aria-hidden="true" />
                <AlertTitle>Copy your new key</AlertTitle>
                <AlertDescription>
                  {newKey.startsWith("sk_")
                    ? "Secret server key. Store it on your backend, never in browser or distributed app code. This is the only time the full key is shown."
                    : "This is the only time the full key is shown."}
                  <code className="new-key">{newKey}</code>
                  <CopyButton
                    content={newKey}
                    onCopyError={() =>
                      setError("Clipboard unavailable. Select the key and copy it manually.")
                    }
                  >
                    Copy key
                  </CopyButton>
                </AlertDescription>
              </Alert>
            )}
            <div className="key-list" aria-busy={keyState.status === "loading"}>
              {keyState.status === "loading" ? (
                <PageLoading label="Loading ingestion keys" />
              ) : keyState.status === "error" ? (
                <ErrorState message={keyState.message} retry={() => void loadKeys()} />
              ) : keyState.keys.length ? (
                keyState.keys.map((k) => (
                  <div className="key-row" key={k.id}>
                    <div>
                      <strong>{k.label}</strong>
                      <code>{k.prefix}••••</code>
                      <span className="quiet">
                        {product.sources?.find((source) => source.id === k.source_id)?.name ??
                          "Initial source"}
                      </span>
                      <span className="quiet [overflow-wrap:anywhere]">
                        {k.kind === "server"
                          ? "Secret server key · Revenue allowed"
                          : k.allowed_origins?.length
                            ? k.allowed_origins.join(", ")
                            : "Any origin · CLI and mobile allowed"}
                      </span>
                    </div>
                    {!k.revoked && k.kind !== "server" && (
                      <KeyOriginsEditor
                        productId={product.id}
                        websites={websiteList(product)}
                        sourceWebsites={
                          product.sources?.find((s) => s.id === k.source_id)?.website_urls
                        }
                        keyInfo={k}
                        disabled={busy}
                        onSaved={() =>
                          loadKeys(undefined, "Origins saved. Could not refresh the key list. ")
                        }
                      />
                    )}
                    {k.revoked ? (
                      <Badge variant="outline">Revoked</Badge>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Revoke ${k.label}`}
                        disabled={busy}
                        onClick={() => {
                          setRevokeError("");
                          setRevoke(k);
                        }}
                      >
                        <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                ))
              ) : (
                <p className="quiet">No keys yet. Create one to start sending events.</p>
              )}
            </div>
            <form
              className="key-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (keyState.status !== "ready") return;
                void action("create-key", async () => {
                  const result = await api<{ id: string; key: string }>(
                    `/products/${product.id}/keys`,
                    "POST",
                    {
                      label,
                      source_id: keySourceId,
                      kind: keyKind,
                      allowed_origins: keyKind === "server" ? [] : parseOrigins(allowedOrigins),
                    },
                  );
                  setCreatedKey(result);
                  if (result.key.startsWith("sk_")) setIntegration("typescript");
                  setLabel("");
                  setNotice("Ingestion key created.");
                  await loadKeys(
                    undefined,
                    "The key was created. Could not refresh the key list. ",
                  );
                });
              }}
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="key-kind">Key type</FieldLabel>
                  <ValueSelect
                    id="key-kind"
                    value={keyKind}
                    disabled={busy || keyState.status !== "ready"}
                    options={[
                      ["public", "Public"],
                      ["server", "Secret server"],
                    ]}
                    onValueChange={setKeyKind}
                  />
                  <FieldDescription>
                    Public keys collect from websites and apps. Secret server keys also accept
                    revenue and must stay on your backend.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="key-source">Key source</FieldLabel>
                  <ValueSelect
                    id="key-source"
                    value={keySourceId}
                    disabled={busy}
                    icon={<SourceIcon name={keySource?.name ?? ""} icon={keySource?.icon} />}
                    options={(product.sources ?? []).map((source) => [
                      source.id,
                      source.name,
                      <SourceIcon key={source.id} name={source.name} icon={source.icon} />,
                    ])}
                    onValueChange={(id) => {
                      setKeySourceId(id);
                      setCreatedKey(null);
                    }}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="key-label">New key label</FieldLabel>
                  <Input
                    id="key-label"
                    disabled={busy || keyState.status !== "ready"}
                    required
                    maxLength={80}
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="e.g. Production website"
                  />
                </Field>
                {keyKind === "public" && (
                  <AllowedOriginsField
                    id="key-origins"
                    websites={websiteList(product)}
                    sourceWebsites={keySource?.website_urls}
                    value={allowedOrigins}
                    onChange={setAllowedOrigins}
                    disabled={busy || keyState.status !== "ready"}
                  />
                )}
                <Button
                  type="submit"
                  variant="outline"
                  disabled={busy || keyState.status !== "ready"}
                  aria-busy={pending === "create-key"}
                >
                  {pending === "create-key" ? (
                    <Spinner data-icon="inline-start" aria-hidden="true" />
                  ) : (
                    <HugeiconsIcon
                      icon={Add01Icon}
                      strokeWidth={2}
                      aria-hidden="true"
                      data-icon="inline-start"
                    />
                  )}
                  {pending === "create-key" ? "Creating key…" : "Create ingestion key"}
                </Button>
              </FieldGroup>
            </form>
            <p className="key-note">
              Browser keys are public identifiers. They can send events, but can’t read data or
              manage your project. Origin restrictions reduce accidental collection and browser
              misuse; a determined sender can forge headers.
            </p>
          </CardContent>
        </Card>
      </div>
      <Card className="integration-card" id="install-guide">
        <CardHeader>
          <div className="card-heading">
            <div>
              <CardTitle>
                <HugeiconsIcon icon={SourceCodeIcon} strokeWidth={2} aria-hidden="true" />
                Connect {keySource?.name ?? "a source"}
              </CardTitle>
              <CardDescription>
                Use a key for this source. Identity is off by default; no users are linked
                automatically.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <IntegrationTabs
            key={keySource?.id}
            value={integration}
            visitorMode={keySource?.visitor_mode}
            onValueChange={setIntegration}
            ingestionKey={newKey}
            onCopyError={() =>
              setError("Clipboard unavailable. Select the snippet and copy it manually.")
            }
          />
        </CardContent>
      </Card>
      <AlertDialog
        open={!!revoke}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setRevoke(null);
            setRevokeError("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {revoke?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              Future requests with this key will be rejected. Events already accepted remain
              available.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {revokeError && (
            <Alert variant="destructive">
              <AlertTitle>Couldn’t revoke this key</AlertTitle>
              <AlertDescription>{revokeError}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void action("revoke", async () => {
                  if (!revoke) return;
                  await api(`/products/${product.id}/keys/${revoke.id}`, "DELETE");
                  if (createdKey?.id === revoke.id) setCreatedKey(null);
                  setRevoke(null);
                  setNotice("Ingestion key revoked.");
                  await loadKeys(
                    undefined,
                    "The key was revoked. Could not refresh the key list. ",
                  );
                });
              }}
            >
              {pending === "revoke" && <Spinner data-icon="inline-start" aria-hidden="true" />}
              {pending === "revoke" ? "Revoking…" : "Revoke key"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
