// The workspace tools: projects, sources, ingestion keys, log keys and log settings, only on the
// full MCP path. They call the operations the HTTP routes call (workspace.ts); this file handles
// arguments, and common.ts turns errors into tool errors that name the argument at fault.
import { listKeys, listLogKeys, logRetention } from "../db/keys";
import { revenueSettings } from "../db/revenue";
import { productRow } from "../db/products";
import { getSource } from "../db/sources";
import {
  connectSource,
  createEventKey,
  createProject,
  createProjectLogKey,
  createSource,
  INTEGRATIONS,
  revokeEventKey,
  revokeProjectLogKey,
  setKeyOrigins,
  snippets,
  updateLogSettings,
  updateRevenueSettings,
  updateProject,
  updateSource,
} from "../operations";
import { badArgument, confirmMismatch, orMissing, projectId, sourceId, type Tool } from "./common";

const URL_NOTE =
  "Replace HIGHKEY_URL with the origin of the Highkey URL this MCP server is reached at. The secret is shown only once.";
const LOGS_NOTE = "For logs, call create_log_key.";
const VERIFY_NOTE =
  "After installing a snippet, send one event, then call sample_events for this project to confirm it arrived; it lists the newest events first.";

export const workspaceTools: Record<string, Tool> = {
  create_project: async (ctx, a) =>
    createProject(ctx, {
      name: a.name,
      website_url: a.website_url ?? null,
      retention_days: a.retention_days ?? 365,
    }),
  update_project: async (ctx, a) => {
    const id = await projectId(ctx, a.project);
    const current = await productRow(ctx.db, id);
    // No website argument keeps the current one; "" removes it.
    return updateProject(ctx, id, {
      name: a.name ?? current.name,
      website_url: a.website_url ?? null,
      retention_days: a.retention_days ?? current.retention_days,
    });
  },
  create_source: async (ctx, a) =>
    createSource(ctx, await projectId(ctx, a.project), { name: a.name, icon: a.icon ?? null }),
  update_source: async (ctx, a) => {
    const id = await projectId(ctx, a.project);
    const source = await sourceId(ctx, id, a.source);
    const current = await getSource(ctx.db, id, source);
    return updateSource(ctx, id, source, {
      name: a.name ?? current.name,
      icon: a.icon ?? current.icon,
    });
  },
  connect_source: async (ctx, a) => {
    if (a.integration != null && !(INTEGRATIONS as readonly string[]).includes(a.integration))
      throw badArgument(
        "/integration",
        `\`${a.integration}\` is not an integration`,
        `Use one of: ${INTEGRATIONS.join(", ")}, or omit it for all`,
      );
    const id = await projectId(ctx, a.project);
    const { source, key } = await connectSource(
      ctx,
      id,
      { name: a.name, icon: a.icon ?? null },
      a.label,
      a.allowed_origins ?? [],
    );
    return {
      source,
      key: {
        id: key.id,
        prefix: key.key.slice(0, 11),
        secret: key.key,
        allowed_origins: key.allowed_origins,
      },
      setup: {
        instructions: URL_NOTE,
        snippets: snippets(a.integration, key.key) ?? {},
        logs: LOGS_NOTE,
        verify: VERIFY_NOTE,
      },
    };
  },
  list_keys: async (ctx, a) => listKeys(ctx.db, await projectId(ctx, a.project)),
  create_key: async (ctx, a) => {
    const id = await projectId(ctx, a.project);
    const source = a.source != null ? await sourceId(ctx, id, a.source) : null;
    return createEventKey(ctx, id, a.label, source, a.allowed_origins ?? [], a.kind ?? "public");
  },
  update_key_origins: async (ctx, a) => {
    const id = await projectId(ctx, a.project);
    const allowed = await orMissing("Key", "Call list_keys for the ids of the active keys", () =>
      setKeyOrigins(ctx, id, a.key, a.allowed_origins),
    );
    return { id: a.key, allowed_origins: allowed };
  },
  revoke_key: async (ctx, a) => {
    const id = await projectId(ctx, a.project);
    if (a.confirm !== a.key) throw confirmMismatch("revoke", "key", "id", a.key);
    await orMissing("Key", "Call list_keys for the key ids", () => revokeEventKey(ctx, id, a.key));
    return { id: a.key, revoked: true };
  },
  list_log_keys: async (ctx, a) => listLogKeys(ctx.db, await projectId(ctx, a.project)),
  create_log_key: async (ctx, a) => {
    const id = await projectId(ctx, a.project);
    const source = a.source != null ? await sourceId(ctx, id, a.source) : null;
    return createProjectLogKey(ctx, id, a.label, source);
  },
  revoke_log_key: async (ctx, a) => {
    const id = await projectId(ctx, a.project);
    if (a.confirm !== a.key) throw confirmMismatch("revoke", "log key", "id", a.key);
    await orMissing("Key", "Call list_log_keys for the key ids", () =>
      revokeProjectLogKey(ctx, id, a.key),
    );
    return { id: a.key, revoked: true };
  },
  update_log_settings: async (ctx, a) => {
    const id = await projectId(ctx, a.project);
    if (a.retention_days == null) return { retention_days: await logRetention(ctx.db, id) };
    return updateLogSettings(ctx, id, a.retention_days);
  },
  update_revenue_settings: async (ctx, a) => {
    const id = await projectId(ctx, a.project);
    if (a.allow_browser_revenue == null) return revenueSettings(ctx.db, id);
    return updateRevenueSettings(ctx, id, a.allow_browser_revenue);
  },
};
