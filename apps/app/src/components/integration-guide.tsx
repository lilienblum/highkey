import { useSyncExternalStore } from "react";
import { CopyButton } from "@/components/ui/copy-button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { highlight } from "@/lib/highlight";

/** The ways a source sends events: the hosted browser tracker, the SDKs, or plain HTTP. */
export type Integration = "browser" | "typescript" | "rust" | "http";

const noopSubscribe = () => () => {};
/** The page's origin; a placeholder on the server so hydration agrees. */
function useOrigin(): string {
  return useSyncExternalStore(
    noopSubscribe,
    () => window.location.origin,
    () => "https://highkey.example.com",
  );
}

/** A working snippet for `integration`, sending to `origin` with `key`. */
export function integrationSnippet(integration: Integration, origin: string, key: string): string {
  if (key.startsWith("sk_")) {
    if (integration === "browser" || integration === "rust")
      return "Use a public key for this integration. Secret server keys must stay on your backend.";
    if (integration === "http")
      return `POST ${origin}/api/ingest\nAuthorization: Bearer ${key}\nContent-Type: application/json\n\n${JSON.stringify({ event_id: "STABLE_PAYMENT_EVENT_ID", name: "purchase", source: "server", timestamp: "UTC_ISO_TIMESTAMP", properties: { revenue: 2950 } }, null, 2)}`;
    return `import { Highkey } from "./sdk/typescript/client";\n\nconst highkey = new Highkey({\n  endpoint: "${origin}",\n  key: process.env.HIGHKEY_SERVER_KEY!,\n});\n\nawait highkey.send({\n  event_id: paymentEvent.id,\n  timestamp: paymentEvent.timestamp,\n  name: "purchase", source: "server",\n  properties: { revenue: 2950 },\n});`;
  }
  switch (integration) {
    case "browser":
      return `<script type="module" referrerpolicy="no-referrer">\n  import { startBrowserTracker } from "${origin}/tracker.js";\n\n  const tracker = startBrowserTracker({\n    endpoint: "${origin}",\n    key: "${key}",\n    identity: "none",\n  });\n\n  tracker.track("signup", { plan: "pro", trial: true, seats: 3 });\n</script>`;
    case "http":
      return `POST ${origin}/api/ingest\nAuthorization: Bearer ${key}\nContent-Type: application/json\n\n${JSON.stringify({ event_id: "GENERATE_A_UUID_ONCE", name: "screen_view", source: "mobile", timestamp: "UTC_ISO_TIMESTAMP", properties: { screen: "home", version: "1.0.0", subscribed: false } }, null, 2)}`;
    case "typescript":
      return `import { Highkey } from "./sdk/typescript/client";\n\nconst highkey = new Highkey({\n  endpoint: "${origin}",\n  key: "${key}",\n  timeoutMs: 800,\n});\n\nawait highkey.send({\n  name: "build_complete", source: "server",\n  properties: { duration_ms: 142, success: true, version: "1.2.0" },\n});`;
    case "rust":
      return `HIGHKEY_TELEMETRY=1 \\\nHIGHKEY_ENDPOINT="${origin}" \\\nHIGHKEY_INGESTION_KEY="${key}" \\\ncargo run -p highkey-sdk --example cli -- build\n\n# Explicit telemetry opt-in; no installation ID is sent.\n# DO_NOT_TRACK=1 disables collection.\n# Delivery has an 800 ms budget, retries included.`;
  }
}

const CAPTION: Record<Integration, string> = {
  browser: "index.html",
  typescript: "analytics.ts",
  rust: "terminal",
  http: "HTTP request",
};

const LANGUAGE: Record<Integration, Parameters<typeof highlight>[1]> = {
  browser: "html",
  typescript: "js",
  rust: "shell",
  http: "http",
};

const NOTE: Record<Integration, string> = {
  browser:
    "No cookies or stored visitor IDs. Campaign capture is off, and DNT/GPC stop collection. Map private routes before collecting page views.",
  typescript:
    "Send only the properties your project needs. No identity is added automatically. Keep emails, credentials, and private content out of events.",
  rust: "Telemetry requires explicit opt-in. No installation ID is created, and unknown command names are reported as other. Never send arguments or output.",
  http: "Send this request from your native app’s HTTP client after opt-in. Generate an event ID and UTC timestamp once, and reuse both on retries. Omit advertising IDs, device fingerprints, and personal data.",
};

/**
 * How to send events with an ingestion key: one tab per integration, each a copyable snippet and
 * what it does (and does not) collect. Without a key the snippets show a placeholder.
 */
export function IntegrationTabs({
  value,
  onValueChange,
  ingestionKey,
  onCopyError,
}: {
  value: Integration;
  onValueChange: (value: Integration) => void;
  ingestionKey?: string;
  onCopyError: () => void;
}) {
  const origin = useOrigin();
  const server = ingestionKey?.startsWith("sk_");
  if (server && (value === "browser" || value === "rust")) value = "typescript";
  const snippet = integrationSnippet(value, origin, ingestionKey || "YOUR_INGESTION_KEY");
  return (
    <Tabs value={value} onValueChange={(next) => onValueChange(next as Integration)}>
      <TabsList
        variant="line"
        aria-label="Integration language"
        className="mb-4 w-full justify-start overflow-x-auto sm:w-auto"
      >
        {!server && <TabsTrigger value="browser">Browser</TabsTrigger>}
        <TabsTrigger value="typescript">TypeScript</TabsTrigger>
        {!server && <TabsTrigger value="rust">Rust CLI</TabsTrigger>}
        <TabsTrigger value="http">{server ? "HTTP / Server" : "HTTP / Mobile"}</TabsTrigger>
      </TabsList>
      <TabsContent value={value} key={value}>
        <div className="code-toolbar">
          <span>{CAPTION[value]}</span>
          <CopyButton variant="ghost" content={snippet} onCopyError={onCopyError}>
            Copy snippet
          </CopyButton>
        </div>
        <pre className="integration-code">
          <code>{highlight(snippet, LANGUAGE[value])}</code>
        </pre>
        <p className="quiet">
          {server
            ? "Store your secret as HIGHKEY_SERVER_KEY on the backend. Reuse the payment event ID and timestamp on retries. Revenue is integer cents; use negative cents for refunds."
            : NOTE[value]}
        </p>
      </TabsContent>
    </Tabs>
  );
}
