export const webMetricLabels = {
  visitors: "Visitors",
  sessions: "Sessions",
  page_views: "Page views",
  pages_per_session: "Pages per session",
  bounce_rate: "Bounce rate",
  session_duration: "Session duration",
  revenue: "Revenue",
} as const;
export type WebMetric = keyof typeof webMetricLabels;
export function webMetric(value: unknown): WebMetric | undefined {
  const key = typeof value === "string" && value.startsWith("web_") ? value.slice(4) : "";
  return Object.hasOwn(webMetricLabels, key) ? (key as WebMetric) : undefined;
}
