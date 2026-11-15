// The examples in docs/dashboards.md are the ones agents and people copy, so they must stay
// valid against the published schema and the validation rules.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { checkDocument, parseDocument } from "../src/server/dashboards/validate";

const DOCS = new URL("../../../docs/dashboards.md", import.meta.url);

/** The JSON of every fenced block whose info string is exactly `json <tag>`. */
export function blocks(tag: string): { line: number; text: string }[] {
  const found: { line: number; text: string }[] = [];
  let open: { line: number; text: string } | null = null;
  readFileSync(DOCS, "utf8")
    .split("\n")
    .forEach((line, n) => {
      if (!open && line.trimEnd() === `\`\`\`json ${tag}`) open = { line: n + 1, text: "" };
      else if (open && line.trimEnd() === "```") {
        found.push(open);
        open = null;
      } else if (open) open.text += `${line}\n`;
    });
  if (open) throw new Error(`an unclosed \`\`\`json ${tag} block`);
  return found;
}

describe("documentation examples", () => {
  test("docs_examples_validate_against_schema_and_rules", () => {
    const dashboards = blocks("piko-dashboard");
    expect(dashboards.length).toBeGreaterThanOrEqual(4);
    let sql = 0;
    for (const { line, text } of dashboards) {
      const parsed = parseDocument(JSON.parse(text));
      if (!parsed.ok)
        throw new Error(
          `dashboard at line ${line} does not parse: ${JSON.stringify(parsed.report.errors)}`,
        );
      expect({ line, errors: checkDocument(parsed.value).errors }).toEqual({ line, errors: [] });
      sql += text.split('"signal": "sql"').length - 1;
    }
    expect(sql).toBeGreaterThanOrEqual(1);
  });
});
