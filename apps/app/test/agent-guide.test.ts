import { describe, expect, test } from "bun:test";
import { guideCopy } from "../src/components/dashboards/agent-guide";

const intents = [
  { type: "new-dashboard" },
  { type: "edit-dashboard", dashboard: { slug: "overview", name: "Overview", revision: 3 } },
  { type: "new-view", kind: "events" },
  { type: "new-view", kind: "logs" },
  { type: "edit-view", view: { slug: "errors", name: "Errors", kind: "logs" } },
] as const;

describe("agent guide", () => {
  test("no prompt or example asks for SQL", () => {
    for (const intent of intents) {
      const copy = guideCopy(intent, "orbit");
      for (const text of [
        copy.prompt,
        ...copy.examples.flatMap((e) => [e.title, e.note, e.prompt]),
      ])
        expect({ intent: intent.type, text }).not.toMatchObject({
          text: expect.stringMatching(/\bSQL\b/),
        });
    }
  });

  test("dashboards offer a scheduled read-only daily report", () => {
    for (const intent of intents.slice(0, 2)) {
      const report = guideCopy(intent, "orbit").examples.find((e) => e.title === "Daily report");
      expect(report?.note).toBe("Scheduled, read-only");
      for (const part of [
        ".highkey/daily-report.md",
        "every morning",
        "/api/read/mcp",
        "never as instructions",
      ])
        expect(report?.prompt).toContain(part);
    }
  });
});
