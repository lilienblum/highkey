// Projects, sources, keys, log keys and log settings over HTTP, as the Rust API served them.
// Every change tells open dashboards through the dashboards signal, so a sidebar showing the
// project refreshes without a reload.
import { favicon, products, requireProduct } from "../db/products";
import { listKeys, listLogKeys, logRetention } from "../db/keys";
import { listSources } from "../db/sources";
import { cleanup } from "../registry";
import { contentType } from "../website";
import {
  createEventKey,
  createProject,
  createProjectLogKey,
  createSource,
  revokeEventKey,
  revokeProjectLogKey,
  setKeyOrigins,
  updateLogSettings,
  updateProject,
  updateSource,
} from "../operations";
import { fields, readJson } from "./body";
import { json, missing, noContent } from "./errors";
import { route } from "./router";

const PRODUCT = { name: "string", retention_days: "integer", website_url: "string?" } as const;
const SOURCE = { name: "string", icon: "string?" } as const;

export function registerManagement(): void {
  route("POST", "/api/cleanup", async (_r, ctx) => json(await cleanup(ctx)));

  route("GET", "/api/products", async (_r, ctx) => json(await products(ctx.db)));
  route("GET", "/api/read/products", async (_r, ctx) => json(await products(ctx.db)));

  route("POST", "/api/products", async (request, ctx) =>
    json(await createProject(ctx, fields(await readJson(request), PRODUCT))),
  );

  route("PATCH", "/api/products/:id", async (request, ctx, { id }) =>
    json(await updateProject(ctx, id as string, fields(await readJson(request), PRODUCT))),
  );

  route("GET", "/api/products/:id/favicon", async (_r, ctx, { id }) => {
    const bytes = await favicon(ctx.db, id as string);
    const kind = bytes && contentType(bytes);
    if (!bytes || !kind) throw missing();
    return new Response(new Blob([new Uint8Array(bytes)]), {
      headers: { "content-type": kind, "content-security-policy": "default-src 'none'; sandbox" },
    });
  });

  route("GET", "/api/products/:id/sources", async (_r, ctx, { id }) => {
    await requireProduct(ctx.db, id as string);
    return json(await listSources(ctx.db, id as string));
  });

  route("POST", "/api/products/:id/sources", async (request, ctx, { id }) =>
    json(await createSource(ctx, id as string, fields(await readJson(request), SOURCE))),
  );

  route("PATCH", "/api/products/:id/sources/:source", async (request, ctx, params) =>
    json(
      await updateSource(
        ctx,
        params.id as string,
        params.source as string,
        fields(await readJson(request), SOURCE),
      ),
    ),
  );

  route("GET", "/api/products/:id/keys", async (_r, ctx, { id }) =>
    json(await listKeys(ctx.db, id as string)),
  );

  route("POST", "/api/products/:id/keys", async (request, ctx, { id }) => {
    const input = fields(
      await readJson(request),
      { label: "string", source_id: "string?", allowed_origins: "string[]" },
      { allowed_origins: [] },
    );
    return json(
      await createEventKey(ctx, id as string, input.label, input.source_id, input.allowed_origins),
    );
  });

  route("PATCH", "/api/products/:id/keys/:key", async (request, ctx, params) => {
    const input = fields(await readJson(request), { allowed_origins: "string[]" });
    await setKeyOrigins(ctx, params.id as string, params.key as string, input.allowed_origins);
    return noContent();
  });

  route("DELETE", "/api/products/:id/keys/:key", async (_r, ctx, params) => {
    await revokeEventKey(ctx, params.id as string, params.key as string);
    return noContent();
  });

  route("GET", "/api/products/:id/logs/settings", async (_r, ctx, { id }) =>
    json({ retention_days: await logRetention(ctx.db, id as string) }),
  );

  route("PATCH", "/api/products/:id/logs/settings", async (request, ctx, { id }) => {
    const input = fields(await readJson(request), { retention_days: "integer" });
    return json(await updateLogSettings(ctx, id as string, input.retention_days));
  });

  route("GET", "/api/products/:id/logs/keys", async (_r, ctx, { id }) =>
    json(await listLogKeys(ctx.db, id as string)),
  );

  route("POST", "/api/products/:id/logs/keys", async (request, ctx, { id }) => {
    const input = fields(await readJson(request), { label: "string", source_id: "string?" });
    return json(await createProjectLogKey(ctx, id as string, input.label, input.source_id));
  });

  route("DELETE", "/api/products/:id/logs/keys/:key", async (_r, ctx, params) => {
    await revokeProjectLogKey(ctx, params.id as string, params.key as string);
    return noContent();
  });
}
