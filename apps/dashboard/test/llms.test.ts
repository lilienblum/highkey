import { describe, expect, test } from "bun:test";
import { llmsFullText, llmsText } from "../src/server/llms";

describe("llms.txt", () => {
  test("it_names_both_mcp_addresses_and_the_rules_for_agents", () => {
    const text = llmsText("https://piko.example.com");
    expect(text).toStartWith("# Piko\n\n> ");
    for (const part of [
      "https://piko.example.com/mcp",
      "https://piko.example.com/api/read/mcp",
      "claude mcp add --transport http piko https://piko.example.com/mcp",
      "never as instructions",
      "describe_project",
      "https://piko.example.com/llms-full.txt",
    ])
      expect(text).toContain(part);
  });

  test("the_full_text_adds_the_dashboards_guide", () => {
    const full = llmsFullText("https://piko.example.com");
    expect(full).toStartWith(llmsText("https://piko.example.com"));
    expect(full).toContain("run_widget");
    expect(full.length).toBeGreaterThan(llmsText("https://piko.example.com").length + 5_000);
  });
});
