/** Closed set of virtual property names available in event queries and saved views. */
export const eventContext = {
  country: "Country",
  region: "Region",
  device: "Device",
  browser: "Browser",
  browser_version: "Browser version",
  os_family: "Operating system",
  os_version: "OS version",
  referrer_name: "Traffic source",
  referrer_type: "Traffic type",
  bot: "Bot label",
} as const;
export function contextColumn(key: string): keyof typeof eventContext | undefined {
  const field = key.startsWith("context.") ? key.slice(8) : "";
  return Object.hasOwn(eventContext, field) ? (field as keyof typeof eventContext) : undefined;
}
