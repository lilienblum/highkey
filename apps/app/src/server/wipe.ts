// Wiping a deleted project once its 7-day grace has passed: its events and logs, its ClickHouse
// reader and views, its management rows and its mirrored keys, as separate idempotent steps
// (each a `ctx.run` step of the `wipe-project` workflow under Tako). The first step checks the
// project is still deleted with the same deletion time, so a restored project, or one deleted
// again later, is never wiped by an older run.
import type { ApiContext } from "./api/context";
import { forgetOrganization } from "./auth/org-cleanup";
import { dropProjectAccess } from "./clickhouse/access";
import { type Db, one } from "./db/db";

export const RESTORE_DAYS = 7;

export interface WipePayload {
  project: string;
  deletedAt: string;
  /** When this attempt started: each attempt is its own run. */
  attemptedAt?: string;
}

/** How long a started wipe has before the reconcile tries it again as a new run. */
export const WIPE_RETRY_MS = 3_600_000;

/**
 * The run id of one wipe attempt: repeating the enqueue of an attempt starts nothing, and a new
 * attempt (an hour after one that failed for good) is a new run.
 */
export const wipeRunId = (payload: WipePayload) =>
  `wipe:${payload.project}:${payload.deletedAt}:${payload.attemptedAt ?? "first"}`;

/** Deletions at or before this moment are past their grace. */
export function graceCutoff(now: Date): string {
  return new Date(now.getTime() - RESTORE_DAYS * 86_400_000).toISOString();
}

/**
 * The next project whose grace has passed and whose wipe is not already under way: never
 * attempted first (oldest deletion first), then the longest-waiting retry. It is marked as
 * attempted now, so the next reconcile moves on to another project while this one runs, and a
 * wipe that fails for good is tried again, as a new run, an hour later. One per reconcile, so
 * wipes (each a ClickHouse delete over a project's rows) start one project at a time.
 */
export async function dueWipe(db: Db, now: Date): Promise<WipePayload | null> {
  return db.transaction(async (tx) => {
    const row = await one<{ id: string; deleted_at: string }>(
      tx,
      `SELECT id, deleted_at FROM products
       WHERE deleted_at IS NOT NULL AND deleted_at <= ?
         AND (wipe_attempted_at IS NULL OR wipe_attempted_at <= ?)
       ORDER BY wipe_attempted_at IS NOT NULL, wipe_attempted_at, deleted_at, id LIMIT 1`,
      [graceCutoff(now), new Date(now.getTime() - WIPE_RETRY_MS).toISOString()],
    );
    if (!row) return null;
    const attemptedAt = now.toISOString();
    await tx.execute("UPDATE products SET wipe_attempted_at = ? WHERE id = ?", [
      attemptedAt,
      row.id,
    ]);
    return { project: row.id, deletedAt: row.deleted_at, attemptedAt };
  });
}

type Step = <T>(name: string, work: () => Promise<T>) => Promise<T>;
const direct: Step = (_name, work) => work();

/** Deletes a project's management rows; returns its organization. */
async function deleteRows(db: Db, project: string): Promise<string | null> {
  return db.transaction(async (tx) => {
    const row = await one<{ org_id: string | null }>(
      tx,
      "SELECT org_id FROM products WHERE id = ?",
      [project],
    );
    // Dashboards, their revisions, views and retention changes go by cascade.
    for (const table of ["ingestion_keys", "log_keys", "log_settings", "sources"])
      await tx.execute(`DELETE FROM ${table} WHERE product_id = ?`, [project]);
    await tx.execute("DELETE FROM products WHERE id = ?", [project]);
    return row?.org_id ?? null;
  });
}

/** An organization left with no members and no projects (its person deleted their account). */
async function removeEmptyOrganization(db: Db, orgId: string | null): Promise<void> {
  if (!orgId) return;
  const empty = await one(
    db,
    `SELECT 1 AS empty FROM organization o WHERE o.id = ?
       AND NOT EXISTS (SELECT 1 FROM member m WHERE m."organizationId" = o.id)
       AND NOT EXISTS (SELECT 1 FROM products p WHERE p.org_id = o.id)`,
    [orgId],
  );
  if (!empty) return;
  await forgetOrganization(db, orgId);
  await db.execute("DELETE FROM organization WHERE id = ?", [orgId]);
}

export async function wipeProject(
  ctx: ApiContext,
  { project, deletedAt }: WipePayload,
  step: Step = direct,
): Promise<"wiped" | "skipped"> {
  const pending = await step("check", async () =>
    Boolean(
      await one(ctx.db, "SELECT 1 AS found FROM products WHERE id = ? AND deleted_at = ?", [
        project,
        deletedAt,
      ]),
    ),
  );
  if (!pending) return "skipped";
  const params = { p: project };
  await step("events", () =>
    ctx.admin.command("DELETE FROM highkey.events WHERE product_id = {p:UUID}", { params }),
  );
  await step("logs", () =>
    ctx.admin.command("DELETE FROM highkey.logs WHERE product_id = {p:UUID}", { params }),
  );
  for (const table of ["profiles", "groups", "session_events", "session_profiles", "event_facets"])
    await step(table, () =>
      ctx.admin.command(`DELETE FROM highkey.${table} WHERE product_id = {p:UUID}`, { params }),
    );
  await step("access", () => dropProjectAccess(ctx.admin, project));
  const org = await step("rows", () => deleteRows(ctx.db, project));
  // After the rows: a reconcile in between would mirror the keys again.
  await step("keys", () =>
    ctx.admin.command("DELETE FROM highkey.ingest_keys WHERE product_id = {p:UUID}", { params }),
  );
  await step("key-policies", () =>
    ctx.admin.command("DELETE FROM highkey.ingest_key_policies WHERE product_id = {p:UUID}", {
      params,
    }),
  );
  await step("organization", () => removeEmptyOrganization(ctx.db, org));
  await step("visitor-policies", () =>
    ctx.admin.command("DELETE FROM highkey.visitor_policies WHERE product_id={p:UUID}", { params }),
  );
  return "wiped";
}
