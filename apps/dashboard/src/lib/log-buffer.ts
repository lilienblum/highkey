import type { LogResult } from "./logs";
// Rows are virtualized, so this bounds browser memory only; older pages load as the reader scrolls.
export const MAX_BUFFERED_LOGS = 10_000;
export function appendLogPage(current: LogResult, page: LogResult): LogResult {
  const seen = new Set(current.logs.map((log) => log.log_id));
  const combined = [...current.logs];
  for (const log of page.logs) {
    if (!seen.has(log.log_id)) {
      seen.add(log.log_id);
      combined.push(log);
    }
  }
  const logs = combined.slice(0, MAX_BUFFERED_LOGS);
  const last = logs.at(-1);
  return {
    ...current,
    logs,
    next_cursor:
      combined.length > MAX_BUFFERED_LOGS && last
        ? { timestamp: last.timestamp, log_id: last.log_id }
        : page.logs.length && combined.length > current.logs.length
          ? page.next_cursor
          : null,
  };
}
