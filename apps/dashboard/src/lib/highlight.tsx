import type { ReactNode } from "react";

/**
 * Small lexical highlighters for the dashboard's own snippets and JSON views. They colour tokens
 * with the Kanagawa syntax roles in styles.css (`.tok-*`); they never parse or validate. Output
 * is plain spans, so it renders identically on the server and in the browser.
 */
export type CodeLanguage = "json" | "js" | "html" | "shell" | "http" | "sql";
type Kind =
  | "string"
  | "number"
  | "constant"
  | "keyword"
  | "function"
  | "type"
  | "property"
  | "variable"
  | "flag"
  | "tag"
  | "punct"
  | "comment";
type Token = { kind?: Kind; text: string };
type Rule = [RegExp, Kind | ((match: string, rest: string) => Kind | undefined)];

function scan(source: string, rules: Rule[]): Token[] {
  const tokens: Token[] = [];
  let plain = "";
  let index = 0;
  outer: while (index < source.length) {
    for (const [pattern, kind] of rules) {
      pattern.lastIndex = index;
      const match = pattern.exec(source);
      if (match && match.index === index && match[0]) {
        if (plain) tokens.push({ text: plain });
        plain = "";
        const resolved =
          typeof kind === "function" ? kind(match[0], source.slice(index + match[0].length)) : kind;
        tokens.push({ kind: resolved, text: match[0] });
        index += match[0].length;
        continue outer;
      }
    }
    plain += source[index];
    index += 1;
  }
  if (plain) tokens.push({ text: plain });
  return tokens;
}

const NUMBER = /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y;
const jsonRules: Rule[] = [
  [/"(?:[^"\\]|\\.)*"/y, (_match, rest) => (/^\s*:/.test(rest) ? "property" : "string")],
  [NUMBER, "number"],
  [/\b(?:true|false|null)\b/y, "constant"],
  [/[{}[\],:]/y, "punct"],
];
const jsRules: Rule[] = [
  [/\/\/[^\n]*|\/\*[\s\S]*?\*\//y, "comment"],
  [/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/y, "string"],
  [NUMBER, "number"],
  [/\b(?:true|false|null|undefined)\b/y, "constant"],
  [
    /\b(?:import|from|export|const|let|var|await|async|new|return|function|if|else|type|interface)\b/y,
    "keyword",
  ],
  [/\b[A-Z][A-Za-z0-9_]*\b/y, "type"],
  [
    /\b[A-Za-z_$][\w$]*\b/y,
    (_match, rest) =>
      /^\s*\(/.test(rest) ? "function" : /^\s*:(?!:)/.test(rest) ? "property" : undefined,
  ],
  [/[{}()[\];,.:=<>+\-*/!?&|]/y, "punct"],
];
const shellRules: Rule[] = [
  [/#[^\n]*/y, "comment"],
  [/"(?:[^"\\]|\\.)*"|'[^']*'/y, "string"],
  [/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/y, "variable"],
  [/\b[A-Z_][A-Z0-9_]*(?==)/y, "variable"],
  [/(?<=\s)--?[A-Za-z][\w-]*/y, "flag"],
  [/(?<=^|\n)\s*(?:curl|cargo|bun|export|docker)\b/y, "function"],
  [/\\(?=\n)|[=|;]/y, "punct"],
];

const SQL_KEYWORDS = [
  "select",
  "from",
  "where",
  "group",
  "by",
  "order",
  "having",
  "limit",
  "offset",
  "as",
  "and",
  "or",
  "not",
  "in",
  "is",
  "like",
  "ilike",
  "between",
  "case",
  "when",
  "then",
  "else",
  "end",
  "join",
  "left",
  "right",
  "inner",
  "outer",
  "full",
  "cross",
  "on",
  "using",
  "union",
  "all",
  "distinct",
  "with",
  "over",
  "partition",
  "asc",
  "desc",
  "cast",
  "interval",
  "exists",
  "qualify",
  "except",
  "intersect",
  "nulls",
  "lateral",
  "recursive",
  "similar",
  "preceding",
  "following",
  "unbounded",
];
const sqlRules: Rule[] = [
  [/--[^\n]*|\/\*[\s\S]*?\*\//y, "comment"],
  [/'(?:[^']|'')*'/y, "string"],
  [/"(?:[^"]|"")*"/y, "property"],
  [/\$[A-Za-z_][A-Za-z0-9_]*/y, "variable"],
  [/\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\.\d+\b/y, "number"],
  [/\b(?:true|false|null)\b/iy, "constant"],
  [
    new RegExp(`\\b(?:${SQL_KEYWORDS.join("|")})\\b`, "iy"),
    // left(...) and right(...) are functions; `LEFT JOIN` is a keyword.
    (match, rest) =>
      /^(?:left|right)$/i.test(match) && /^\s*\(/.test(rest) ? "function" : "keyword",
  ],
  [/\b[A-Za-z_][\w]*\b/y, (_match, rest) => (/^\s*\(/.test(rest) ? "function" : undefined)],
  [/[(),;.*+\-/%=<>!|:[\]{}]/y, "punct"],
];

function sql(source: string) {
  return scan(source, sqlRules);
}
function json(source: string) {
  return scan(source, jsonRules);
}
function js(source: string) {
  return scan(source, jsRules);
}
function shell(source: string) {
  // Single-quoted JSON payloads (curl --data '{...}') get JSON colours inside their quotes.
  return scan(source, shellRules).flatMap((token) =>
    token.kind === "string" && /^'[{[]/.test(token.text)
      ? [
          { kind: "string" as const, text: "'" },
          ...json(token.text.slice(1, -1)),
          { kind: "string" as const, text: "'" },
        ]
      : [token],
  );
}
function html(source: string) {
  // Tags and attributes, with the contents of <script> highlighted as JavaScript.
  const tokens: Token[] = [];
  const tagRules: Rule[] = [
    [/<\/?[A-Za-z][\w-]*|\/?>/y, "tag"],
    [/[A-Za-z-]+(?==)/y, "property"],
    [/"[^"]*"/y, "string"],
    [/=/y, "punct"],
  ];
  const parts = source.split(/(<script[^>]*>|<\/script>)/);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("<")) tokens.push(...scan(part, tagRules));
    else tokens.push(...js(part));
  }
  return tokens;
}
function http(source: string) {
  const split = source.indexOf("\n\n");
  const head = split === -1 ? source : source.slice(0, split);
  const body = split === -1 ? "" : source.slice(split);
  const headRules: Rule[] = [
    [/^(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/y, "keyword"],
    [/(?<=^|\n)[A-Za-z-]+(?=:)/y, "property"],
    [/:/y, "punct"],
  ];
  return [...scan(head, headRules), ...json(body)];
}

const tokenizers: Record<CodeLanguage, (source: string) => Token[]> = {
  json,
  js,
  html,
  shell,
  http,
  sql,
};

/** Lossless token stream: concatenating every token's text returns the source. */
export function tokenize(source: string, language: CodeLanguage) {
  return tokenizers[language](source);
}

/** Highlighted children for a `<code>` element. */
export function highlight(source: string, language: CodeLanguage): ReactNode[] {
  let offset = 0;
  return tokenize(source, language).map((token) => {
    const key = offset;
    offset += token.text.length;
    return token.kind ? (
      <span key={key} className={`tok-${token.kind}`}>
        {token.text}
      </span>
    ) : (
      token.text
    );
  });
}

/**
 * A single structured value without JSON quoting: strings, numbers, booleans and null each take
 * their syntax colour, and objects or arrays render as highlighted JSON. The type stays readable
 * without colour through `title` and a visually hidden label.
 */
export function TypedValue({ value }: { value: unknown }) {
  if (value !== null && typeof value === "object")
    return <code className="typed-value">{highlight(JSON.stringify(value, null, 2), "json")}</code>;
  const kind =
    typeof value === "string" ? "string" : typeof value === "number" ? "number" : "constant";
  const type = value === null ? "null" : typeof value;
  return (
    <code className="typed-value" title={type}>
      <span className={`tok-${kind}`}>{value === null ? "null" : String(value)}</span>
      <span className="sr-only"> ({type})</span>
    </code>
  );
}
