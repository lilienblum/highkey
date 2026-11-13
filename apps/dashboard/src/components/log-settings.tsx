import { useCallback, useEffect, useState, type FormEvent } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Copy01Icon, Tick01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { api, type Product } from "@/lib/api";
import { highlight } from "@/lib/highlight";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Field, FieldLabel, FieldDescription } from "./ui/field";
import { Alert, AlertTitle, AlertDescription } from "./ui/alert";
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "./ui/alert-dialog";
import { ValueSelect } from "./value-select";
import { ErrorState } from "./shared";
type LogKey = { id: string; label: string; prefix: string; source_id: string; revoked: boolean };
export function LogSettings({ product, sourceId }: { product: Product; sourceId?: string }) {
  const [days, setDays] = useState(7);
  const [keys, setKeys] = useState<LogKey[]>();
  const [source, setSource] = useState(sourceId ?? product.sources[0]?.id ?? "");
  useEffect(() => {
    if (!product.sources.some((item) => item.id === source))
      setSource(product.sources[0]?.id ?? "");
  }, [product.sources, source]);
  const [origin, setOrigin] = useState("");
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const [settings, keys] = await Promise.all([
        api<{ retention_days: number }>(
          `/products/${product.id}/logs/settings`,
          "GET",
          undefined,
          signal,
        ),
        api<LogKey[]>(`/products/${product.id}/logs/keys`, "GET", undefined, signal),
      ]);
      setDays(settings.retention_days);
      setKeys(keys);
    },
    [product.id],
  );
  useEffect(() => {
    setOrigin(window.location.origin);
    const controller = new AbortController();
    void load(controller.signal).catch((error) => {
      if (!controller.signal.aborted) setError(error.message);
    });
    return () => controller.abort();
  }, [load]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/products/${product.id}/logs/settings`, "PATCH", { retention_days: days });
      setNotice("Log retention saved.");
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy || created) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ key: string }>(`/products/${product.id}/logs/keys`, "POST", {
        label,
        source_id: source,
      });
      setCreated(result.key);
      setLabel("");
      setCopied(false);
      await load();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api(`/products/${product.id}/logs/keys/${id}`, "DELETE");
      await load();
      setNotice("Log key revoked.");
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="log-settings settings-section" id="logs" tabIndex={-1}>
      <CardHeader>
        <CardTitle>Logs</CardTitle>
        <CardDescription>
          Connect your services and set how long their logs are kept.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {error && (
          <ErrorState
            message={error}
            retry={() => {
              setError("");
              void load().catch((error) => setError(error.message));
            }}
          />
        )}
        {notice && (
          <p role="status" className="quiet">
            {notice}
          </p>
        )}
        <form onSubmit={save} className="flex flex-wrap items-end gap-3">
          <Field className="max-w-xs">
            <FieldLabel htmlFor="log-retention">Log retention (days)</FieldLabel>
            <Input
              id="log-retention"
              type="number"
              min={1}
              max={365}
              required
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
              disabled={busy || !keys}
            />
            <FieldDescription>
              Separate from event retention. Older logs are removed automatically.
            </FieldDescription>
          </Field>
          <Button type="submit" variant="outline" disabled={busy || !keys}>
            Save retention
          </Button>
        </form>
        <div>
          <h3 className="mb-2 text-sm font-medium">Log ingestion keys</h3>
          <p className="quiet mb-4">
            Keep these keys on your servers. Analytics keys cannot send logs, and log keys cannot
            read data.
          </p>
          {source ? (
            <form onSubmit={create} className="log-key-form">
              <Field>
                <FieldLabel htmlFor="log-key-label">Key label</FieldLabel>
                <Input
                  id="log-key-label"
                  value={label}
                  maxLength={80}
                  required
                  placeholder="Production API"
                  onChange={(event) => setLabel(event.target.value)}
                  disabled={busy || !!created}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="log-key-source">Source</FieldLabel>
                <ValueSelect
                  id="log-key-source"
                  label="Log key source"
                  value={source}
                  onValueChange={setSource}
                  options={product.sources.map((source) => [source.id, source.name])}
                  disabled={busy || !!created}
                />
              </Field>
              <Button type="submit" disabled={busy || !!created || !keys}>
                Create log key
              </Button>
            </form>
          ) : (
            <p className="quiet">Add a source above before creating a log key.</p>
          )}
        </div>
        {created && (
          <Alert>
            <AlertTitle>Save your log key</AlertTitle>
            <AlertDescription>
              <p>This key is shown once. Store it securely before dismissing.</p>
              <code className="block break-all py-3 select-all">{created}</code>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(created);
                      setCopied(true);
                    } catch {
                      setError("Could not copy the key. Select and copy it above.");
                    }
                  }}
                >
                  <HugeiconsIcon icon={copied ? Tick01Icon : Copy01Icon} aria-hidden="true" />
                  {copied ? "Copied" : "Copy key"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setCreated(undefined)}>
                  I’ve saved it
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}
        <div className="divide-y divide-border">
          {keys?.length ? (
            keys.map((key) => (
              <div key={key.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {key.label}
                    {key.revoked ? " · Revoked" : ""}
                  </p>
                  <p className="quiet">
                    <code>{key.prefix}…</code> ·{" "}
                    {product.sources.find((source) => source.id === key.source_id)?.name ??
                      "Unknown source"}
                  </p>
                </div>
                {!key.revoked && (
                  <AlertDialog>
                    <AlertDialogTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Revoke log key ${key.label}`}
                          disabled={busy}
                        />
                      }
                    >
                      <HugeiconsIcon icon={Delete02Icon} aria-hidden="true" />
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Revoke this log key?</AlertDialogTitle>
                        <AlertDialogDescription>
                          {key.label} will stop accepting new logs. Existing logs stay available
                          until their retention expires.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => void revoke(key.id)}>
                          Revoke key
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            ))
          ) : (
            <p className="quiet py-3">
              {keys
                ? "No log keys yet. Create one to connect your first service."
                : "Loading log keys…"}
            </p>
          )}
        </div>
        <p className="quiet">
          Send JSON batches to <code>/api/logs/ingest</code>, or use OpenTelemetry HTTP at{" "}
          <code>/api/logs/v1/logs</code>.
        </p>
        <details className="log-setup-guide">
          <summary>Log setup guide</summary>
          <p>
            Set <code>PIKO_LOG_KEY</code> to a log key from this section. Keep it on your server.
          </p>
          <h3>Send JSON</h3>
          <pre>
            <code>
              {highlight(
                `curl --fail-with-body "${origin}/api/logs/ingest" \\\n  -H "Authorization: Bearer $PIKO_LOG_KEY" \\\n  -H "Content-Type: application/json" \\\n  --data '{"service":"api","level":"info","message":"Server started"}'`,
                "shell",
              )}
            </code>
          </pre>
          <h3>Use OpenTelemetry</h3>
          <p>Configure an OTLP/HTTP logs exporter with a batch size of 100 records or fewer.</p>
          <pre>
            <code>
              {highlight(
                `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=${origin}/api/logs/v1/logs
OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_LOGS_HEADERS="Authorization=Bearer $PIKO_LOG_KEY"
OTEL_SERVICE_NAME=api`,
                "shell",
              )}
            </code>
          </pre>
        </details>
      </CardContent>
    </Card>
  );
}
