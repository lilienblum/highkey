import { groupLabel, type Group } from "./api";

/**
 * Reading labels for stored values of well-known dimensions: `macos` reads as macOS, `aarch64`
 * as ARM64. Matching ignores case; unknown values pass through unchanged. Reports and filter chips
 * use these labels, while inspectors, raw JSON, and filters keep the stored literal.
 */
const os: Record<string, string> = {
  macos: "macOS",
  mac: "macOS",
  darwin: "macOS",
  osx: "macOS",
  ios: "iOS",
  ipados: "iPadOS",
  watchos: "watchOS",
  tvos: "tvOS",
  visionos: "visionOS",
  android: "Android",
  windows: "Windows",
  win32: "Windows",
  linux: "Linux",
  chromeos: "ChromeOS",
  freebsd: "FreeBSD",
  openbsd: "OpenBSD",
  netbsd: "NetBSD",
};
const arch: Record<string, string> = {
  x86_64: "x86-64",
  amd64: "x86-64",
  x64: "x86-64",
  aarch64: "ARM64",
  arm64: "ARM64",
  x86: "x86",
  i386: "x86",
  i686: "x86",
  arm: "ARM",
  armv7: "ARMv7",
  riscv64: "RISC-V 64",
};
const browser: Record<string, string> = {
  chrome: "Chrome",
  chromium: "Chromium",
  firefox: "Firefox",
  safari: "Safari",
  edge: "Edge",
  opera: "Opera",
  brave: "Brave",
  vivaldi: "Vivaldi",
  arc: "Arc",
  samsung: "Samsung Internet",
  samsunginternet: "Samsung Internet",
};
const device: Record<string, string> = {
  desktop: "Desktop",
  mobile: "Mobile",
  tablet: "Tablet",
  tv: "TV",
};
const identity: Record<string, string> = {
  visitor: "Visitor",
  installation: "Installation",
  actor: "Actor",
};
const vocabularies: Record<string, Record<string, string>> = {
  os,
  platform: os,
  arch,
  architecture: arch,
  browser,
  device,
  device_type: device,
  identity_kind: identity,
};

/** A dimension key such as `property:os`, `os`, or `identity_kind`, without its prefix. */
const fieldName = (field: string) => field.replace(/^property:/, "");

export function displayValue(field: string | undefined, value: unknown): string {
  if (typeof value === "string" && field) {
    const known = vocabularies[fieldName(field)]?.[value.toLowerCase()];
    if (known) return known;
  }
  return groupLabel(value as Group["label"]);
}

/** Adds reading labels to report groups that do not already carry one (such as source names). */
export function displayGroups(groups: Group[], field: string): Group[] {
  return groups.map((group) =>
    group.display === undefined ? { ...group, display: displayValue(field, group.label) } : group,
  );
}
