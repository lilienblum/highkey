// Projects, sources, keys, log keys and log settings, as one set of operations the HTTP routes
// and the MCP tools both call. Each commits to the management database, then mirrors what the ingest app reads
// (keys, retention, access) to ClickHouse, then tells open dashboards through the dashboards
// signal, so every caller behaves the same.
import type { ApiContext } from "./api/context";
import { ApiError } from "./api/errors";
import { type Actor, memberRole } from "./auth/actor";
import { can } from "./auth/roles";
import { ensureProjectAccess } from "./clickhouse/access";
import { one } from "./db/db";
import {
  createKey,
  createLogKey,
  revokeKey,
  revokeLogKey,
  setLogRetention,
  updateKeyOrigins,
} from "./db/keys";
import {
  cacheFavicon,
  moveProduct,
  type Product,
  type ProductInput,
  product,
  saveProduct,
} from "./db/products";
import { type Source, type SourceInput, saveSource } from "./db/sources";
import {
  afterCommit,
  applyRetentionChanges,
  mirrorKey,
  mirrorProject,
  retentionChanged,
} from "./registry";
import { fetchIcon } from "./website";
import { setRevenueSettings } from "./db/revenue";

let fetchingIcons = 0;

/** Fetches and caches the project's favicon once, at most two at a time. */
async function withFavicon(ctx: ApiContext, project: Product): Promise<Product> {
  const website = project.website_url;
  if (!website || project.favicon_version || fetchingIcons >= 2) return project;
  fetchingIcons++;
  try {
    const bytes = await fetchIcon(website);
    return bytes ? await cacheFavicon(ctx.db, project.id, website, bytes) : project;
  } finally {
    fetchingIcons--;
  }
}

export async function createProject(ctx: ApiContext, input: ProductInput): Promise<Product> {
  // A project belongs to the organization of whoever creates it.
  const project = await saveProduct(ctx.db, null, input, ctx.actor?.orgId ?? null);
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
  const before = (await product(ctx.db, id)).retention_days;
  const project = await ctx.db.transaction(async (tx) => {
    const saved = await saveProduct(tx, id, input);
    if (saved.retention_days !== before) await retentionChanged(tx, ctx.now(), saved.id, "events");
    return saved;
  });
  if (project.retention_days !== before) await applyRetentionChanges(ctx, project.id);
  ctx.changes.notify(project.id, "dashboards");
  return withFavicon(ctx, project);
}

/**
 * Moves a project to another organization (by id or slug), where `actor` must also be able to move
 * projects. Its keys, dashboards and views go with it; ClickHouse is untouched, since its rows and
 * reader belong to the project, not the organization.
 */
export async function moveProject(
  ctx: ApiContext,
  actor: Actor,
  projectId: string,
  target: string,
): Promise<Product> {
  const org = await one<{ id: string }>(
    ctx.db,
    "SELECT id FROM organization WHERE id = ? OR slug = ?",
    [target, target],
  );
  const role = org ? await memberRole(ctx, org.id, actor.userId) : null;
  if (!org || !role || !can(role, { project: ["move"] }))
    throw new ApiError(
      403,
      "Only an admin or owner of the target organization can move a project there",
      {},
      "forbidden",
    );
  const moved = await moveProduct(ctx.db, projectId, org.id);
  ctx.changes.notify(projectId, "dashboards");
  return moved;
}

export async function createSource(
  ctx: ApiContext,
  id: string,
  input: SourceInput,
): Promise<Source> {
  const source = await saveSource(ctx.db, id, null, input);
  ctx.changes.notify(id, "dashboards");
  return source;
}

export async function updateSource(
  ctx: ApiContext,
  id: string,
  sourceId: string,
  input: SourceInput,
): Promise<Source> {
  const source = await saveSource(ctx.db, id, sourceId, input);
  if (input.visitor_mode != null) await mirrorProject(ctx, id);
  ctx.changes.notify(id, "dashboards");
  return source;
}

export async function createEventKey(
  ctx: ApiContext,
  id: string,
  label: string,
  sourceId: string | null | undefined,
  origins: readonly string[],
  kind: string = "public",
) {
  const key = await createKey(ctx.db, id, label, sourceId, origins, kind);
  // The ingest app authorizes from the registry, so the key works once it is mirrored.
  await afterCommit(() => mirrorKey(ctx, id, key.id));
  ctx.changes.notify(id, "dashboards");
  return key;
}

export async function updateRevenueSettings(ctx: ApiContext, id: string, allow: boolean) {
  const saved = await setRevenueSettings(ctx.db, id, allow);
  await afterCommit(() => mirrorProject(ctx, id));
  ctx.changes.notify(id, "dashboards");
  return saved;
}

/** Replaces a key's allowed origins and returns them as normalized. */
export async function setKeyOrigins(
  ctx: ApiContext,
  id: string,
  keyId: string,
  origins: readonly string[],
): Promise<string[]> {
  const normalized = await updateKeyOrigins(ctx.db, id, keyId, origins);
  await afterCommit(() => mirrorKey(ctx, id, keyId));
  ctx.changes.notify(id, "dashboards");
  return normalized;
}

export async function revokeEventKey(ctx: ApiContext, id: string, keyId: string): Promise<void> {
  await revokeKey(ctx.db, id, keyId);
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
  const { source, key } = await ctx.db.transaction(async (tx) => {
    const source = await saveSource(tx, id, null, input);
    const key = await createKey(tx, id, label ?? input.name.trim(), source.id, origins);
    return { source, key };
  });
  await afterCommit(() => mirrorKey(ctx, id, key.id));
  ctx.changes.notify(id, "dashboards");
  return { source, key };
}

export async function updateLogSettings(ctx: ApiContext, id: string, days: number) {
  const retention = await ctx.db.transaction(async (tx) => {
    const saved = await setLogRetention(tx, id, days);
    await retentionChanged(tx, ctx.now(), id, "logs");
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
  const key = await createLogKey(ctx.db, id, label, sourceId);
  await afterCommit(() => mirrorKey(ctx, id, key.id));
  return key;
}

export async function revokeProjectLogKey(ctx: ApiContext, id: string, keyId: string) {
  await revokeLogKey(ctx.db, id, keyId);
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
