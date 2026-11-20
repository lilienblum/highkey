// Arithmetic formulas over widget query ids, such as `errors / requests * 100`.
import { nearest } from "./suggest";

const MAX_LEN = 200;
const MAX_DEPTH = 16;

export type Expr =
  | { kind: "number"; value: number }
  | { kind: "query"; id: string }
  | { kind: "neg"; inner: Expr }
  | { kind: "binary"; op: "+" | "-" | "*" | "/"; left: Expr; right: Expr }
  | { kind: "call"; func: "min" | "max" | "abs"; args: Expr[] };

export interface FormulaError {
  /** 1-based position in characters. */
  column: number;
  message: string;
}

type Token =
  | { t: "number"; value: number }
  | { t: "ident"; name: string }
  | { t: "+" | "-" | "*" | "/" | "(" | ")" | "," | "end" };

function describe(token: Token): string {
  if (token.t === "number") return "a number";
  if (token.t === "ident") return `\`${token.name}\``;
  if (token.t === "end") return "the end of the formula";
  return `\`${token.t}\``;
}

class Failure extends Error {
  constructor(
    readonly column: number,
    message: string,
  ) {
    super(message);
  }
}

function tokenize(chars: string[]): [number, Token][] {
  const tokens: [number, Token][] = [];
  let i = 0;
  const digits = () => {
    while (i < chars.length && /[0-9]/.test(chars[i] as string)) i++;
  };
  while (i < chars.length) {
    const c = chars[i] as string;
    const column = i + 1;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if ("+-*/(),".includes(c)) {
      tokens.push([column, { t: c as "+" }]);
      i++;
    } else if (/[0-9.]/.test(c)) {
      const start = i;
      digits();
      if (chars[i] === ".") {
        i++;
        digits();
      }
      if (chars[i] === "e") {
        let j = i + 1;
        if (chars[j] === "+" || chars[j] === "-") j++;
        if (j < chars.length && /[0-9]/.test(chars[j] as string)) {
          i = j;
          digits();
        } else throw new Failure(i + 1, "expected digits in the exponent");
      }
      const text = chars.slice(start, i).join("");
      const value = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/.test(text) ? Number(text) : Number.NaN;
      if (!Number.isFinite(value)) throw new Failure(column, `\`${text}\` is not a valid number`);
      tokens.push([column, { t: "number", value }]);
    } else if (/[a-z]/.test(c)) {
      const start = i;
      while (i < chars.length && /[a-z0-9_]/.test(chars[i] as string)) i++;
      tokens.push([column, { t: "ident", name: chars.slice(start, i).join("") }]);
    } else throw new Failure(column, `unexpected character \`${c}\``);
  }
  tokens.push([chars.length + 1, { t: "end" }]);
  return tokens;
}

class Parser {
  private at = 0;
  private depth = 0;
  constructor(
    private readonly tokens: [number, Token][],
    private readonly known: readonly string[],
  ) {}

  private peek(): Token {
    return (this.tokens[this.at] as [number, Token])[1];
  }

  next(): [number, Token] {
    const token = this.tokens[this.at] as [number, Token];
    if (token[1].t !== "end") this.at++;
    return token;
  }

  private enter(column: number) {
    if (++this.depth > MAX_DEPTH)
      throw new Failure(column, `nesting is deeper than ${MAX_DEPTH} levels`);
  }

  private expect(wanted: Token["t"]) {
    const [column, token] = this.next();
    if (token.t !== wanted)
      throw new Failure(
        column,
        `expected ${describe({ t: wanted } as Token)}, found ${describe(token)}`,
      );
  }

  expr(): Expr {
    let left = this.term();
    for (;;) {
      const t = this.peek().t;
      if (t !== "+" && t !== "-") return left;
      this.next();
      left = { kind: "binary", op: t, left, right: this.term() };
    }
  }

  private term(): Expr {
    let left = this.unary();
    for (;;) {
      const t = this.peek().t;
      if (t !== "*" && t !== "/") return left;
      this.next();
      left = { kind: "binary", op: t, left, right: this.unary() };
    }
  }

  private unary(): Expr {
    if (this.peek().t === "-") {
      this.next();
      return { kind: "neg", inner: this.unary() };
    }
    return this.atom();
  }

  private atom(): Expr {
    const [column, token] = this.next();
    if (token.t === "number") return { kind: "number", value: token.value };
    if (token.t === "(") {
      this.enter(column);
      const inner = this.expr();
      this.expect(")");
      this.depth--;
      return inner;
    }
    if (token.t === "ident" && this.peek().t === "(") {
      const func = token.name;
      if (func !== "min" && func !== "max" && func !== "abs")
        throw new Failure(
          column,
          `unknown function \`${func}\`; available functions: min, max, abs`,
        );
      this.next();
      this.enter(column);
      const args = [this.expr()];
      while (this.peek().t === ",") {
        this.next();
        args.push(this.expr());
      }
      this.expect(")");
      this.depth--;
      const arity = func === "abs" ? 1 : 2;
      if (args.length !== arity)
        throw new Failure(
          column,
          `\`${func}\` takes ${arity} argument${arity === 1 ? "" : "s"}, found ${args.length}`,
        );
      return { kind: "call", func, args };
    }
    if (token.t === "ident") {
      if (this.known.includes(token.name)) return { kind: "query", id: token.name };
      const suggestion = nearest(token.name, this.known);
      throw new Failure(
        column,
        suggestion
          ? `unknown query \`${token.name}\`; did you mean \`${suggestion}\`?`
          : `unknown query \`${token.name}\``,
      );
    }
    throw new Failure(column, `expected a number, query or \`(\`, found ${describe(token)}`);
  }
}

export function parseFormula(
  source: string,
  known: readonly string[],
): { ok: true; expr: Expr } | { ok: false; error: FormulaError } {
  const chars = [...source];
  try {
    if (chars.length > MAX_LEN)
      throw new Failure(MAX_LEN + 1, `formula is longer than ${MAX_LEN} characters`);
    const parser = new Parser(tokenize(chars), known);
    const expr = parser.expr();
    const [column, token] = parser.next();
    if (token.t !== "end") throw new Failure(column, `unexpected ${describe(token)}`);
    return { ok: true, expr };
  } catch (error) {
    if (error instanceof Failure)
      return { ok: false, error: { column: error.column, message: error.message } };
    throw error;
  }
}

/** Evaluates to null for a missing operand, division by zero or a non-finite result. */
export function evaluate(expr: Expr, lookup: (id: string) => number | null): number | null {
  const run = (e: Expr): number | null => {
    switch (e.kind) {
      case "number":
        return e.value;
      case "query":
        return lookup(e.id);
      case "neg": {
        const v = run(e.inner);
        return v === null ? null : -v;
      }
      case "binary": {
        const l = run(e.left);
        const r = run(e.right);
        if (l === null || r === null) return null;
        if (e.op === "/" && r === 0) return null;
        return e.op === "+" ? l + r : e.op === "-" ? l - r : e.op === "*" ? l * r : l / r;
      }
      case "call": {
        const values = e.args.map(run);
        if (values.some((v) => v === null)) return null;
        const [a, b] = values as number[];
        return e.func === "min"
          ? Math.min(a as number, b as number)
          : e.func === "max"
            ? Math.max(a as number, b as number)
            : Math.abs(a as number);
      }
    }
  };
  const value = run(expr);
  return value !== null && Number.isFinite(value) ? value : null;
}

/** The query ids a formula uses, sorted. */
export function references(expr: Expr): Set<string> {
  const found = new Set<string>();
  const walk = (e: Expr) => {
    if (e.kind === "query") found.add(e.id);
    else if (e.kind === "neg") walk(e.inner);
    else if (e.kind === "binary") {
      walk(e.left);
      walk(e.right);
    } else if (e.kind === "call") e.args.forEach(walk);
  };
  walk(expr);
  return new Set([...found].sort());
}
