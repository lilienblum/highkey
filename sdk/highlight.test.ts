import { expect, test } from "bun:test";
import { tokenize, type CodeLanguage } from "../apps/dashboard/src/lib/highlight";

const samples: [CodeLanguage, string][] = [
  [
    "json",
    JSON.stringify({ name: "signup", count: 3, ok: true, none: null, tags: ["a", "b"] }, null, 2),
  ],
  [
    "html",
    `<script type="module" referrerpolicy="no-referrer">\n  import { startBrowserTracker } from "https://highkey.test/tracker.js";\n  const tracker = startBrowserTracker({ key: "pk_1", identity: "none" });\n  tracker.track("signup", { plan: "pro", seats: 3 });\n</script>`,
  ],
  [
    "js",
    `import { Highkey } from "./client";\n// comment\nawait highkey.send({ name: "build", properties: { duration_ms: 142, success: true } });`,
  ],
  [
    "shell",
    `curl --fail-with-body "$URL/api/logs/ingest" \\\n  -H "Authorization: Bearer $HIGHKEY_LOG_KEY" \\\n  --data '{"logs":[{"level":"info","status":200}]}'\n# note\nHIGHKEY_TELEMETRY=1 cargo run -p highkey`,
  ],
  [
    "http",
    `POST https://highkey.test/api/ingest\nAuthorization: Bearer pk\nContent-Type: application/json\n\n{"name":"screen_view","subscribed":false}`,
  ],
];

test("highlighting is lossless for every snippet language", () => {
  for (const [language, source] of samples)
    expect(
      tokenize(source, language)
        .map((token) => token.text)
        .join(""),
    ).toBe(source);
});

test("tokens take the expected syntax roles", () => {
  const kinds = (language: CodeLanguage, source: string) =>
    Object.fromEntries(
      tokenize(source, language)
        .filter((token) => token.kind)
        .map((token) => [token.text, token.kind]),
    );
  expect(kinds("json", '{"name": "signup", "n": 3, "ok": false}')).toMatchObject({
    '"name"': "property",
    '"signup"': "string",
    "3": "number",
    false: "constant",
  });
  const shell = kinds("shell", `curl -H "A: b" --data '{"level":"info"}' # done\nHIGHKEY_KEY=1`);
  expect(shell).toMatchObject({
    curl: "function",
    "-H": "flag",
    "--data": "flag",
    '"level"': "property",
    '"info"': "string",
    "# done": "comment",
    HIGHKEY_KEY: "variable",
  });
  expect(kinds("js", "await highkey.send({ name: 1 });")).toMatchObject({
    await: "keyword",
    send: "function",
    name: "property",
    "1": "number",
  });
  expect(kinds("html", '<script type="module"></script>')).toMatchObject({
    "<script": "tag",
    type: "property",
    '"module"': "string",
  });
  expect(kinds("http", "POST /x\nAuthorization: Bearer k\n\n{}")).toMatchObject({
    POST: "keyword",
    Authorization: "property",
  });
});
