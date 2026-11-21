/** Directory filters shared by group activity and profiles. */
export function groupSearch(s: Record<string, unknown>) {
  return {
    find: typeof s.find === "string" && s.find.length <= 256 ? s.find : undefined,
    groupType:
      typeof s.groupType === "string" && /^[a-zA-Z0-9_./-]{1,64}$/.test(s.groupType)
        ? s.groupType
        : undefined,
    groupId: typeof s.groupId === "string" && s.groupId.length <= 128 ? s.groupId : undefined,
    cohort: typeof s.cohort === "string" && /^[0-9a-f-]{36}$/.test(s.cohort) ? s.cohort : undefined,
    page:
      typeof s.page === "number" && Number.isInteger(s.page) && s.page > 1 && s.page <= 10000
        ? s.page
        : undefined,
  };
}
