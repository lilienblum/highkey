/**
 * How long an unused query stays cached. An explicit lifetime starts a timer, and on the server
 * that timer would keep each request's whole QueryClient in memory until it fired, so the server
 * render never schedules one (its client is dropped with the request). The browser keeps `ms`.
 */
export const browserGcTime = (ms: number) =>
  typeof window === "undefined" ? Number.POSITIVE_INFINITY : ms;
