// Projects, sources, keys, log keys and log settings over HTTP, as the Rust API served them.
// Every change tells open dashboards through the dashboards signal, so a sidebar showing the
// project refreshes without a reload.
import {
  cacheFavicon,
  favicon,
  product,
  products,
  requireProduct,
  saveProduct,
} from "../db/products";
import {
  createKey,
  createLogKey,
  listKeys,
  listLogKeys,
  logRetention,
  revokeKey,
  revokeLogKey,
  setLogRetention,
  updateKeyOrigins,
} from "../db/keys";
import { listSources, saveSource } from "../db/sources";
import { ensureProjectAccess } from "../clickhouse/access";
import { afterCommit, applyRetention, cleanup, mirrorKey, mirrorProject } from "../registry";
import { contentType, fetchIcon } from "../website";
import { fields, readJson } from "./body";
import type { ApiContext } from "./context";
import { json, missing, noContent } from "./errors";
import { route } from "./router";

let fetchingIcons = 0;

/** Fetches and caches the project's favicon once, at most two at a time. */
async function withFavicon(ctx: ApiContext, project: ReturnType<typeof product>) {
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

const PRODUCT = { name: "string", retention_days: "integer", website_url: "string?" } as const;
const SOURCE = { name: "string", icon: "string?" } as const;

export function registerManagement(): void {
  route("POST", "/api/cleanup", async (_r, ctx) => json(await cleanup(ctx)));

  route("GET", "/api/products", async (_r, ctx) => json(products(ctx.store)));
  route("GET", "/api/read/products", async (_r, ctx) => json(products(ctx.store)));

  route("POST", "/api/products", async (request, ctx) => {
    const input = fields(await readJson(request), PRODUCT);
    const project = saveProduct(ctx.store, null, input);
    await afterCommit(async () => {
      await ensureProjectAccess(ctx.admin, project.id, ctx.secret);
      await mirrorProject(ctx, project.id);
    });
    ctx.changes.notify(project.id, "dashboards");
    return json(await withFavicon(ctx, project));
  });

  route("PATCH", "/api/products/:id", async (request, ctx, { id }) => {
    const input = fields(await readJson(request), PRODUCT);
    const before = product(ctx.store, id as string).retention_days;
    const project = saveProduct(ctx.store, id as string, input);
    if (project.retention_days !== before)
      await afterCommit(async () => {
        await applyRetention(ctx, project.id, "piko.events", project.retention_days);
        await mirrorProject(ctx, project.id);
      });
    ctx.changes.notify(project.id, "dashboards");
    return json(await withFavicon(ctx, project));
  });

  route("GET", "/api/products/:id/favicon", async (_r, ctx, { id }) => {
    const bytes = favicon(ctx.store, id as string);
    const kind = bytes && contentType(bytes);
    if (!bytes || !kind) throw missing();
    return new Response(new Blob([new Uint8Array(bytes)]), {
      headers: { "content-type": kind, "content-security-policy": "default-src 'none'; sandbox" },
    });
  });

  route("GET", "/api/products/:id/sources", async (_r, ctx, { id }) => {
    requireProduct(ctx.store, id as string);
    return json(listSources(ctx.store, id as string));
  });

  route("POST", "/api/products/:id/sources", async (request, ctx, { id }) => {
    const source = saveSource(
      ctx.store,
      id as string,
      null,
      fields(await readJson(request), SOURCE),
    );
    ctx.changes.notify(id as string, "dashboards");
    return json(source);
  });

  route("PATCH", "/api/products/:id/sources/:source", async (request, ctx, params) => {
    const source = saveSource(
      ctx.store,
      params.id as string,
      params.source as string,
      fields(await readJson(request), SOURCE),
    );
    ctx.changes.notify(params.id as string, "dashboards");
    return json(source);
  });

  route("GET", "/api/products/:id/keys", async (_r, ctx, { id }) =>
    json(listKeys(ctx.store, id as string)),
  );

  route("POST", "/api/products/:id/keys", async (request, ctx, { id }) => {
    const input = fields(
      await readJson(request),
      { label: "string", source_id: "string?", allowed_origins: "string[]" },
      { allowed_origins: [] },
    );
    const key = createKey(
      ctx.store,
      id as string,
      input.label,
      input.source_id,
      input.allowed_origins,
    );
    ctx.changes.notify(id as string, "dashboards");
    return json(key);
  });

  route("PATCH", "/api/products/:id/keys/:key", async (request, ctx, params) => {
    const input = fields(await readJson(request), { allowed_origins: "string[]" });
    updateKeyOrigins(ctx.store, params.id as string, params.key as string, input.allowed_origins);
    await afterCommit(() => mirrorKey(ctx, params.id as string, params.key as string));
    ctx.changes.notify(params.id as string, "dashboards");
    return noContent();
  });

  route("DELETE", "/api/products/:id/keys/:key", async (_r, ctx, params) => {
    revokeKey(ctx.store, params.id as string, params.key as string);
    await afterCommit(() => mirrorKey(ctx, params.id as string, params.key as string));
    ctx.changes.notify(params.id as string, "dashboards");
    return noContent();
  });

  route("GET", "/api/products/:id/logs/settings", async (_r, ctx, { id }) =>
    json({ retention_days: logRetention(ctx.store, id as string) }),
  );

  route("PATCH", "/api/products/:id/logs/settings", async (request, ctx, { id }) => {
    const input = fields(await readJson(request), { retention_days: "integer" });
    const days = setLogRetention(ctx.store, id as string, input.retention_days);
    await afterCommit(async () => {
      await applyRetention(ctx, id as string, "piko.logs", days);
      await mirrorProject(ctx, id as string);
    });
    return json({ retention_days: days });
  });

  route("GET", "/api/products/:id/logs/keys", async (_r, ctx, { id }) =>
    json(listLogKeys(ctx.store, id as string)),
  );

  route("POST", "/api/products/:id/logs/keys", async (request, ctx, { id }) => {
    const input = fields(await readJson(request), { label: "string", source_id: "string?" });
    const key = createLogKey(ctx.store, id as string, input.label, input.source_id);
    await afterCommit(() => mirrorKey(ctx, id as string, key.id));
    return json(key);
  });

  route("DELETE", "/api/products/:id/logs/keys/:key", async (_r, ctx, params) => {
    revokeLogKey(ctx.store, params.id as string, params.key as string);
    await afterCommit(() => mirrorKey(ctx, params.id as string, params.key as string));
    return noContent();
  });
}
