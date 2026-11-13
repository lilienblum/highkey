import { expect, test } from "bun:test";
import { displayGroups, displayValue } from "../apps/dashboard/src/lib/display-values";

test("known dimension values read with their proper names; everything else is unchanged", () => {
  expect(displayValue("property:os", "macos")).toBe("macOS");
  expect(displayValue("os", "iOS")).toBe("iOS");
  expect(displayValue("property:os", "IPADOS")).toBe("iPadOS");
  expect(displayValue("property:arch", "aarch64")).toBe("ARM64");
  expect(displayValue("property:arch", "x86_64")).toBe("x86-64");
  expect(displayValue("identity_kind", "installation")).toBe("Installation");
  expect(displayValue("property:path", "macos")).toBe("macos");
  expect(displayValue("property:os", "haiku")).toBe("haiku");
  expect(displayValue("property:os", null)).toBe("Not provided");
  expect(displayValue("property:os", "")).toBe("Empty string");
  expect(displayValue(undefined, 42)).toBe("42");
});

test("report groups keep existing labels such as source names", () => {
  const groups = displayGroups(
    [
      { label: "linux", value: 2, count: 2 },
      { label: "s-1", display: "Website", value: 1, count: 1 },
    ],
    "property:os",
  );
  expect(groups.map((group) => group.display)).toEqual(["Linux", "Website"]);
  expect(groups[0].label).toBe("linux");
});
