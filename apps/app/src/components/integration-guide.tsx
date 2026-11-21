import { useState, useSyncExternalStore } from "react";
import { CopyButton } from "@/components/ui/copy-button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { highlight } from "@/lib/highlight";
import { ValueSelect } from "./value-select";
import type { Source } from "@/lib/api";

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

const placements = {
  html: ["index.html", "Place this module script before the closing </body> in your shared HTML."],
  react: [
    "index.html (Vite / React)",
    "Place this module script in the root index.html, after the app entry. It observes client-side navigation itself.",
  ],
  next: [
    "app/layout.tsx (Next.js)",
    'Save the module below as public/highkey.mjs. In your root layout import Script from \'next/script\' and add <Script src="/highkey.mjs" type="module" strategy="afterInteractive" /> inside <body>.',
  ],
  vue: [
    "index.html (Vite / Vue)",
    "Place this module script in the root index.html once. Do not reinitialize it on each route change.",
  ],
  svelte: [
    "src/app.html (SvelteKit)",
    "Place this module script before the closing </body> of src/app.html. It runs only in the browser.",
  ],
  astro: [
    "src/layouts/Layout.astro",
    "Place the module script before </body> in your shared layout. Keep is:inline on the script so Astro serves the hosted import unchanged.",
  ],
} as const;

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
  visitorMode,
  consentPrompt = "site",
  consentTheme = "auto",
  onCopyError,
}: {
  value: Integration;
  onValueChange: (value: Integration) => void;
  ingestionKey?: string;
  visitorMode?: "off" | "cookieless" | "persistent";
  consentPrompt?: Source["consent_prompt"];
  consentTheme?: Source["consent_theme"];
  onCopyError: () => void;
}) {
  const origin = useOrigin();
  const [framework, setFramework] = useState<keyof typeof placements>("html");
  const server = ingestionKey?.startsWith("sk_");
  if (server && (value === "browser" || value === "rust")) value = "typescript";
  const key = ingestionKey || "YOUR_INGESTION_KEY";
  const builtIn = visitorMode === "persistent" && consentPrompt !== "site";
  let raw = integrationSnippet(value, origin, key);
  if (value === "browser" && visitorMode && visitorMode !== "off") {
    raw = raw.replace('identity: "none"', `identity: "${visitorMode}"`);
    if (builtIn)
      raw = `<script type="module" referrerpolicy="no-referrer">\n  import { registerAnalyticsConsent } from "${origin}/tracker.js";\n\n  const consent = registerAnalyticsConsent({\n    endpoint: "${origin}",\n    key: "${key}",\n    appearance: { layout: "${consentPrompt}", theme: "${consentTheme}" },\n  });\n  // In your footer: <button type="button" data-highkey-privacy>Privacy preferences</button>\n</script>`;
    else if (visitorMode === "persistent")
      raw = `<script type="module" referrerpolicy="no-referrer">\n  import { startBrowserTracker } from "${origin}/tracker.js";\n\n  let tracker;\n  // Call this from your existing consent manager on load and when consent changes.\n  function analyticsConsentChanged(allowed) {\n    if (allowed) {\n      tracker ??= startBrowserTracker({ endpoint: "${origin}", key: "${key}", identity: "persistent" });\n    } else {\n      tracker?.optOut();\n      tracker = undefined;\n    }\n  }\n</script>`;
  }
  const snippet =
    value !== "browser"
      ? raw
      : framework === "next"
        ? raw
            .split("\n")
            .slice(1, -1)
            .map((s) => s.replace(/^  /, ""))
            .join("\n")
        : framework === "astro"
          ? raw.replace("<script ", "<script is:inline ")
          : raw;
  const curl = `EVENT_ID="$(uuidgen)"\ncurl --fail-with-body '${origin}/api/ingest' \\\n  -H 'Authorization: Bearer ${key}' \\\n  -H 'Content-Type: application/json' \\\n  --data "{\\"event_id\\":\\"$EVENT_ID\\",\\"name\\":\\"setup_check\\",\\"source\\":\\"http\\"}"`;
  const identityInstruction =
    value === "browser" && visitorMode === "persistent"
      ? builtIn
        ? `Use registerAnalyticsConsent with the ${consentPrompt} layout and ${consentTheme} theme, and add a data-highkey-privacy button to the footer. Do not start a second tracker.`
        : "Start persistent tracking only from the site's existing analytics consent handler; opt out when consent is withdrawn."
      : value === "browser" && visitorMode === "cookieless"
        ? "Use cookieless daily visitor counting."
        : "Keep anonymous collection; do not enable identity.";
  const prompt = `Install Highkey analytics in this ${value === "browser" ? placements[framework][0] : value} project using ${origin} as the endpoint. ${server ? "Read HIGHKEY_SERVER_KEY only from the backend environment." : "Read the source's public ingestion key from the project's configuration."} Inspect the existing framework and install once. ${identityInstruction} Honor DNT/GPC, exclude private routes, secrets and personal data, and keep campaign capture off. Send one setup_check event and verify the acknowledgment and source in Highkey.`;
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
        {value === "browser" && (
          <div className="mb-3 grid gap-2">
            <ValueSelect
              label="Install framework"
              value={framework}
              options={[
                ["html", "Plain HTML"],
                ["react", "React (Vite)"],
                ["next", "Next.js"],
                ["vue", "Vue (Vite)"],
                ["svelte", "SvelteKit"],
                ["astro", "Astro"],
              ]}
              onValueChange={(v) => setFramework(v as keyof typeof placements)}
            />
            <p className="quiet">{placements[framework][1]}</p>
          </div>
        )}
        <div className="code-toolbar">
          <span>
            {value === "browser"
              ? framework === "next"
                ? "public/highkey.mjs"
                : placements[framework][0]
              : CAPTION[value]}
          </span>
          <CopyButton variant="ghost" content={snippet} onCopyError={onCopyError}>
            Copy snippet
          </CopyButton>
        </div>
        <pre className="integration-code">
          <code>
            {highlight(
              snippet,
              value === "browser" && framework === "next" ? "js" : LANGUAGE[value],
            )}
          </code>
        </pre>
        <p className="quiet">
          {server
            ? "Store your secret as HIGHKEY_SERVER_KEY on the backend. Reuse the payment event ID and timestamp on retries. Revenue is integer cents; use negative cents for refunds."
            : value === "browser" && visitorMode === "persistent"
              ? builtIn
                ? "Highkey asks before counting visits. Add a Privacy preferences button to your footer so visitors can change their choice."
                : "Connect this function to your site's analytics consent manager."
              : value === "browser" && visitorMode === "cookieless"
                ? "No device storage. Anonymous visitor hashes expire at UTC midnight."
                : NOTE[value]}
        </p>
        <details className="mt-3">
          <summary>Test with curl</summary>
          <p className="quiet">Run from a terminal. Keep the same event ID if you retry.</p>
          <pre className="setup-curl">
            <code>{highlight(curl, "shell")}</code>
          </pre>
          <CopyButton content={curl} onCopyError={onCopyError}>
            Copy curl command
          </CopyButton>
        </details>
        <details className="mt-3">
          <summary>Install with AI</summary>
          <p className="quiet">{prompt}</p>
          <CopyButton content={prompt} onCopyError={onCopyError}>
            Copy install prompt
          </CopyButton>
        </details>
      </TabsContent>
    </Tabs>
  );
}
