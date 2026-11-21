// The dashboard and view tools that change something, only on the full MCP path. They call the
// functions the HTTP routes call, so validation, the save bench, the write limit, conflicts and
// live hints behave identically; MCP writes record the `mcp` origin.
import { createFor, removeFor, restoreFor, updateFor } from "../dashboards/routes";
import { getDashboard } from "../dashboards/storage";
import { createReference } from "../references";
import { createFor as createView, deleteFor, getView, replaceFor } from "../views";
import { badArgument, confirmMismatch, projectId, type Tool } from "./common";

/** The saved dashboard as a tool returns it: where it is and how it fared, not its document. */
const summary = (saved: Awaited<ReturnType<typeof createFor>>) => ({
  id: saved.id,
  slug: saved.slug,
  revision: saved.revision,
  warnings: saved.warnings,
  bench: saved.bench,
});

export const writeTools: Record<string, Tool> = {
  create_reference: async (ctx, { project, ...note }) =>
    createReference(ctx, await projectId(ctx, project), note),
  save_dashboard: async (ctx, a) => {
    const id = await projectId(ctx, a.project);
    if (a.dashboard == null) {
      if (a.base_revision != null)
        throw badArgument(
          "/base_revision",
          "base_revision applies to updates",
          "Pass `dashboard` as well to update one, or drop base_revision to create",
        );
      return summary(await createFor(ctx, id, a.document, "mcp"));
    }
    if (a.base_revision == null)
      throw badArgument(
        "/base_revision",
        "base_revision is required to update a dashboard",
        "Call get_dashboard and pass its `revision` as base_revision",
      );
    return summary(await updateFor(ctx, id, a.dashboard, a.base_revision, a.document, "mcp"));
  },
  restore_revision: async (ctx, a) =>
    summary(await restoreFor(ctx, await projectId(ctx, a.project), a.dashboard, a.revision, "mcp")),
  delete_dashboard: async (ctx, a) => {
    const id = await projectId(ctx, a.project);
    const stored = await getDashboard(ctx.db, id, a.dashboard);
    if (a.confirm !== stored.slug)
      throw confirmMismatch("delete", "dashboard", "slug", stored.slug);
    await removeFor(ctx, id, stored.id);
    return { deleted: stored.slug };
  },
  save_view: async (ctx, a) => {
    const id = await projectId(ctx, a.project);
    return a.view == null
      ? createView(ctx, id, a.document)
      : replaceFor(ctx, id, a.view, a.document);
  },
  delete_view: async (ctx, a) => {
    const id = await projectId(ctx, a.project);
    const stored = await getView(ctx.db, id, a.view, a.kind ?? null);
    if (a.confirm !== stored.slug) throw confirmMismatch("delete", "view", "slug", stored.slug);
    await deleteFor(ctx, id, stored.id, null);
    return { deleted: stored.slug };
  },
};
