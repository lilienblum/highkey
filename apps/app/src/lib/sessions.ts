import { validId } from "./workspace-search";

export type Visit = { source_id: string; actor_id: string; session_id: string };
export type SessionsSearch = {
  find?: string;
  bounced?: boolean;
  views?: number;
  durationMs?: number;
  profile?: string;
  visit?: Visit;
  page?: number;
  invalidSessions?: true;
};
const uint = (v: unknown, max: number) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;
const id = (v: unknown) =>
  typeof v === "string" && v.length > 0 && new TextEncoder().encode(v).length <= 128;
export function sessionsSearch(s: Record<string, unknown>): SessionsSearch {
  const v = s.visit as Visit | undefined;
  if (
    s.invalidSessions ||
    (s.find !== undefined && !(typeof s.find === "string" && s.find.length <= 512)) ||
    (s.bounced !== undefined && typeof s.bounced !== "boolean") ||
    (s.views !== undefined && !uint(s.views, Number.MAX_SAFE_INTEGER)) ||
    (s.durationMs !== undefined && !uint(s.durationMs, Number.MAX_SAFE_INTEGER)) ||
    (s.profile !== undefined && !id(s.profile)) ||
    (s.page !== undefined && (!uint(s.page, 10000) || s.page === 0)) ||
    (v !== undefined && (!v || !validId(v.source_id) || !id(v.actor_id) || !id(v.session_id)))
  )
    return { invalidSessions: true };
  return {
    find: s.find as string | undefined,
    bounced: s.bounced as boolean | undefined,
    views: s.views as number | undefined,
    durationMs: s.durationMs as number | undefined,
    profile: s.profile as string | undefined,
    visit: v && { source_id: v.source_id, actor_id: v.actor_id, session_id: v.session_id },
    page: s.page as number | undefined,
  };
}
