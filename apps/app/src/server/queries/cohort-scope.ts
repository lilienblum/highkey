import type { ApiContext } from "../api/context";
import { bad } from "../api/errors";
import { one } from "../db/db";
export async function cohortScope(ctx: ApiContext, id: string, cohort: string | null | undefined) {
  if (!cohort) return "";
  if (!(await one(ctx.db, "SELECT 1 FROM cohorts WHERE product_id=? AND id=?", [id, cohort])))
    throw bad("Unknown project cohort");
  return "profile_id IN (SELECT profile_id FROM cohort_members WHERE cohort_id={cohort:UUID})";
}
