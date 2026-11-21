import { fields, readJson } from "../api/body";
import { bad, json, noContent } from "../api/errors";
import { route } from "../api/router";
import { all } from "../db/db";
import { resolveProduct } from "../db/products";
import { requireActor } from "./actor";
import { memberForScope } from "./project-access";

export function registerProjectAccess() {
  const path = "/api/members/:member/projects";
  route("GET", path, { member: ["update"] }, async (_r, ctx, { member }) => {
    const target = await memberForScope(ctx.db, requireActor(ctx), member);
    const rows = await all<{ id: string | null; access: "read" | "write" | null }>(
      ctx.db,
      `SELECT g.project_id AS id,g.access FROM restricted_members r LEFT JOIN member_projects g ON g.member_id=r.member_id WHERE r.member_id=?`,
      [target.id],
    );
    return json({ mode: rows.length ? "selected" : "all", projects: rows.filter((r) => r.id) });
  });
  route("PUT", path, { member: ["update"] }, async (r, ctx, { member }) => {
    const actor = requireActor(ctx);
    const q = fields(await readJson(r), { mode: "string", projects: "unknown" }, { projects: [] });
    if (
      !["all", "selected"].includes(q.mode) ||
      !Array.isArray(q.projects) ||
      q.projects.length > 1000 ||
      (q.mode === "all" && q.projects.length)
    )
      throw bad("Choose all projects or up to 1,000 selected projects");
    const chosen = q.projects.map((s) => fields(s, { id: "string", access: "string" }));
    if (
      chosen.some((p) => p.access !== "read" && p.access !== "write") ||
      new Set(chosen.map((p) => p.id)).size !== chosen.length
    )
      throw bad("Specify read or write once per project");
    await ctx.db.transaction(async (tx) => {
      const target = await memberForScope(tx, actor, member);
      await tx.execute("DELETE FROM restricted_members WHERE member_id=?", [target.id]);
      if (q.mode === "all") return;
      await tx.execute("INSERT INTO restricted_members VALUES (?)", [target.id]);
      for (const p of chosen) {
        const project = await resolveProduct(tx, p.id, actor.orgId);
        if (project.id !== p.id) throw bad("Use project IDs");
        await tx.execute("INSERT INTO member_projects VALUES (?,?,?)", [target.id, p.id, p.access]);
      }
    });
    return noContent();
  });
}
