import { validId } from "./workspace-search";
export function cohortSearch(s: Record<string, unknown>) {
  return { cohort: s.cohort == null ? undefined : validId(s.cohort) ? s.cohort : "invalid" };
}
