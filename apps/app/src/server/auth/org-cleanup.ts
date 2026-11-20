// What goes with an organization: its API keys and agent connections (which Better Auth does not
// tie to it with foreign keys), and any session that had it open. Members and invitations go by
// cascade when the organization row does.
import type { Db } from "../db/db";

export async function forgetOrganization(db: Db, orgId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute("DELETE FROM apikey WHERE json_extract(metadata, '$.orgId') = ?", [orgId]);
    for (const table of ["oauthAccessToken", "oauthRefreshToken", "oauthConsent"])
      await tx.execute(`DELETE FROM "${table}" WHERE "referenceId" = ?`, [orgId]);
    await tx.execute(
      'UPDATE session SET "activeOrganizationId" = NULL WHERE "activeOrganizationId" = ?',
      [orgId],
    );
  });
}

/** How many projects an organization holds, deleted-but-not-wiped ones included. */
export async function projectCount(db: Db, orgId: string): Promise<number> {
  const { rows } = await db.execute("SELECT count(*) AS n FROM products WHERE org_id = ?", [orgId]);
  return Number(rows[0]?.n ?? 0);
}
