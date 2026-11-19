// Projects, sources, keys, log keys and log settings, as one set of operations the HTTP routes
// and the MCP tools both call. Each commits to SQLite, then mirrors what the ingest app reads
// (keys, retention, access) to ClickHouse, then tells open dashboards through the dashboards
// signal, so every caller behaves the same.
import type { ApiContext } from "./api/context";
import { ensureProjectAccess } from "./clickhouse/access";
import {
  createKey,
  createLogKey,
  revokeKey,
  revokeLogKey,
  setLogRetention,
  updateKeyOrigins,
} from "./db/keys";
import { cacheFavicon, type Product, type ProductInput, product, saveProduct } from "./db/products";
import { type Source, type SourceInput, saveSource } from "./db/sources";
import {
  afterCommit,
  applyRetentionChanges,
  mirrorKey,
  mirrorProject,
  retentionChanged,
} from "./registry";
import { fetchIcon } from "./website";

let fetchingIcons = 0;

/** Fetches and caches the project's favicon once, at most two at a time. */
async function withFavicon(ctx: ApiContext, project: Product): Promise<Product> {
  const website = project.website_url;
  if (!website || project.favicon_version || fetchingIcons >= 2) return project;
  fetchingIcons++;
  try {
    const bytes = await fetchIcon(website);
    return bytes ? cacheFavicon(ctx.store, project.id, website, bytes) : project;
  } finally {
    fetchingIcons--;
  }
}

export async function createProject(ctx: ApiContext, input: ProductInput): Promise<Product> {
  const project = saveProduct(ctx.store, null, input);
  await afterCommit(async () => {
    await ensureProjectAccess(ctx.admin, project.id, ctx.secret);
    await mirrorProject(ctx, project.id);
  });
  ctx.changes.notify(project.id, "dashboards");
  return withFavicon(ctx, project);
}

export async function updateProject(
  ctx: ApiContext,
  id: string,
  input: ProductInput,
): Promise<Product> {
  const before = product(ctx.store, id).retention_days;
  const project = ctx.store.transaction(() => {
    const saved = saveProduct(ctx.store, id, input);
    if (saved.retention_days !== before) retentionChanged(ctx, saved.id, "events");
    return saved;
  });
  if (project.retention_days !== before) await applyRetentionChanges(ctx, project.id);
  ctx.changes.notify(project.id, "dashboards");
  return withFavicon(ctx, project);
}

export function createSource(ctx: ApiContext, id: string, input: SourceInput): Source {
  const source = saveSource(ctx.store, id, null, input);
  ctx.changes.notify(id, "dashboards");
  return source;
}

export function updateSource(
  ctx: ApiContext,
  id: string,
  sourceId: string,
  input: SourceInput,
): Source {
  const source = saveSource(ctx.store, id, sourceId, input);
  ctx.changes.notify(id, "dashboards");
  return source;
}

export async function createEventKey(
  ctx: ApiContext,
  id: string,
  label: string,
  sourceId: string | null | undefined,
  origins: readonly string[],
) {
  const key = createKey(ctx.store, id, label, sourceId, origins);
  // The ingest app authorizes from the registry, so the key works once it is mirrored.
  await afterCommit(() => mirrorKey(ctx, id, key.id));
  ctx.changes.notify(id, "dashboards");
  return key;
}

/** Replaces a key's allowed origins and returns them as normalized. */
export async function setKeyOrigins(
  ctx: ApiContext,
  id: string,
  keyId: string,
  origins: readonly string[],
): Promise<string[]> {
  const normalized = updateKeyOrigins(ctx.store, id, keyId, origins);
  await afterCommit(() => mirrorKey(ctx, id, keyId));
  ctx.changes.notify(id, "dashboards");
  return normalized;
}

export async function revokeEventKey(ctx: ApiContext, id: string, keyId: string): Promise<void> {
  revokeKey(ctx.store, id, keyId);
  await afterCommit(() => mirrorKey(ctx, id, keyId));
  ctx.changes.notify(id, "dashboards");
}

/**
 * Creates a source and an ingestion key bound to it in one transaction, so a key that cannot be
 * created (a bad label or origin) leaves no source behind. The label defaults to the name.
 */
export async function connectSource(
  ctx: ApiContext,
  id: string,
  input: SourceInput,
  label: string | null | undefined,
  origins: readonly string[],
) {
  const { source, key } = ctx.store.transaction(() => {
    const source = saveSource(ctx.store, id, null, input);
    const key = createKey(ctx.store, id, label ?? input.name.trim(), source.id, origins);
    return { source, key };
  });
  await afterCommit(() => mirrorKey(ctx, id, key.id));
  ctx.changes.notify(id, "dashboards");
  return { source, key };
}

export async function updateLogSettings(ctx: ApiContext, id: string, days: number) {
  const retention = ctx.store.transaction(() => {
    const saved = setLogRetention(ctx.store, id, days);
    retentionChanged(ctx, id, "logs");
    return saved;
  });
  await applyRetentionChanges(ctx, id);
  return { retention_days: retention };
}

export async function createProjectLogKey(
  ctx: ApiContext,
  id: string,
  label: string,
  sourceId?: string | null,
) {
  const key = createLogKey(ctx.store, id, label, sourceId);
  await afterCommit(() => mirrorKey(ctx, id, key.id));
  return key;
}

export async function revokeProjectLogKey(ctx: ApiContext, id: string, keyId: string) {
  revokeLogKey(ctx.store, id, keyId);
  await afterCommit(() => mirrorKey(ctx, id, keyId));
}

export const INTEGRATIONS = ["browser", "typescript", "http", "rust"] as const;

/** Ready-to-paste setup snippets for a new key, or only one integration's. */
export function snippets(
  integration: string | null | undefined,
  secret: string,
): Record<string, string> | null {
  const URL = "HIGHKEY_URL";
  const all: Record<(typeof INTEGRATIONS)[number], string> = {
    browser: `<script type="module" referrerpolicy="no-referrer">\n  import { startBrowserTracker } from "${URL}/tracker.js";\n\n  const tracker = startBrowserTracker({\n    endpoint: "${URL}",\n    key: "${secret}",\n    identity: "none",\n  });\n\n  tracker.track("signup", { plan: "pro", trial: true, seats: 3 });\n</script>`,
    typescript: `import { Highkey } from "./sdk/typescript/client";\n\nconst highkey = new Highkey({\n  endpoint: "${URL}",\n  key: "${secret}",\n  timeoutMs: 800,\n});\n\nawait highkey.send({\n  name: "build_complete", source: "server",\n  properties: { duration_ms: 142, success: true, version: "1.2.0" },\n});`,
    http: `POST ${URL}/api/ingest\nAuthorization: Bearer ${secret}\nContent-Type: application/json\n\n{\n  "event_id": "GENERATE_A_UUID_ONCE",\n  "name": "screen_view",\n  "source": "mobile",\n  "timestamp": "UTC_ISO_TIMESTAMP",\n  "properties": {\n    "screen": "home",\n    "version": "1.0.0",\n    "subscribed": false\n  }\n}`,
    rust: `HIGHKEY_TELEMETRY=1 \\\nHIGHKEY_ENDPOINT="${URL}" \\\nHIGHKEY_INGESTION_KEY="${secret}" \\\ncargo run -p highkey-sdk --example cli -- build\n\n# Explicit telemetry opt-in; no installation ID is sent.\n# DO_NOT_TRACK=1 disables collection.\n# Delivery has an 800 ms budget, retries included.`,
  };
  if (integration == null) return all;
  if (!(INTEGRATIONS as readonly string[]).includes(integration)) return null;
  return { [integration]: all[integration as (typeof INTEGRATIONS)[number]] };
}
