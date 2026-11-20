// Checks a JSON value against the published dashboard schema and reports the first problem as
// serde would: a JSON Pointer path and a message such as "unknown field `colour`". The schema
// file is the single source of which fields exist, so the validator cannot drift from it.

type Schema = any;

export class ShapeError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

export function pointer(segments: readonly string[]): string {
  return segments.map((s) => `/${s.replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return `boolean \`${value}\``;
  if (typeof value === "number")
    return Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``;
  if (typeof value === "string") return `string ${JSON.stringify(value)}`;
  if (Array.isArray(value)) return "sequence";
  return "map";
}

const quoted = (names: readonly string[]) => names.map((n) => `\`${n}\``);

function expectedList(names: readonly string[]): string {
  const q = quoted(names);
  if (q.length === 1) return q[0] as string;
  if (q.length === 2) return `${q[0]} or ${q[1]}`;
  return `one of ${q.join(", ")}`;
}

const RANGES: Record<string, [number, number, string]> = {
  uint8: [0, 255, "u8"],
  uint32: [0, 4_294_967_295, "u32"],
  uint64: [0, Number.MAX_SAFE_INTEGER, "u64"],
};

export class SchemaParser {
  constructor(private readonly root: Schema) {}

  private resolve(schema: Schema): Schema {
    while (schema && typeof schema === "object" && "$ref" in schema) {
      const name = String(schema.$ref).replace("#/$defs/", "");
      schema = this.root.$defs[name];
    }
    return schema;
  }

  /** The string values a string-enum schema allows, or null if it is not one. */
  private variants(schema: Schema): string[] | null {
    if (schema.enum) return schema.enum;
    if (schema.const !== undefined && typeof schema.const === "string") return [schema.const];
    if (schema.oneOf?.every((s: Schema) => s.enum || typeof s.const === "string"))
      return schema.oneOf.flatMap((s: Schema) => s.enum ?? [s.const]);
    return null;
  }

  /** Parses `value` against `schema`, returning it with schema defaults filled in. */
  parse(schema: Schema, value: unknown, path: string[] = []): unknown {
    if (schema === true) return value;
    const s = this.resolve(schema);
    if (s.anyOf) {
      if (value === null && s.anyOf.some((b: Schema) => b.type === "null")) return null;
      return this.parse(
        s.anyOf.find((b: Schema) => b.type !== "null"),
        value,
        path,
      );
    }
    const variants = this.variants(s);
    if (variants) {
      if (typeof value !== "string")
        throw new ShapeError(
          pointer(path),
          `invalid type: ${describeValue(value)}, expected ${expectedList(variants)}`,
        );
      if (!variants.includes(value))
        throw new ShapeError(
          pointer(path),
          `unknown variant \`${value}\`, expected ${expectedList(variants)}`,
        );
      return value;
    }
    if (s.oneOf) return this.tagged(s.oneOf, value, path);
    const types: string[] = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
    if (value === null && types.includes("null")) return null;
    const kind = types.find((t) => t !== "null");
    const fail = (expected: string): never => {
      throw new ShapeError(
        pointer(path),
        `invalid type: ${describeValue(value)}, expected ${expected}`,
      );
    };
    switch (kind) {
      case "string":
        return typeof value === "string" ? value : fail("a string");
      case "boolean":
        return typeof value === "boolean" ? value : fail("a boolean");
      case "number":
        return typeof value === "number" ? value : fail("f64");
      case "integer": {
        const [min, max, name] = RANGES[s.format] ?? [
          Number.MIN_SAFE_INTEGER,
          Number.MAX_SAFE_INTEGER,
          "an integer",
        ];
        if (typeof value !== "number" || !Number.isInteger(value)) return fail(name);
        if (value < min || value > max)
          throw new ShapeError(
            pointer(path),
            `invalid value: integer \`${value}\`, expected ${name}`,
          );
        return value;
      }
      case "array": {
        if (!Array.isArray(value)) return fail("a sequence");
        return value.map((item, i) => this.parse(s.items, item, [...path, String(i)]));
      }
      case "object":
        return this.object(s, value, path);
      default:
        return value;
    }
  }

  private object(s: Schema, value: unknown, path: string[]): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new ShapeError(pointer(path), `invalid type: ${describeValue(value)}, expected a map`);
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const properties: Record<string, Schema> = s.properties ?? {};
    for (const [key, item] of Object.entries(input)) {
      const field = properties[key];
      if (field !== undefined) out[key] = this.parse(field, item, [...path, key]);
      else if (s.additionalProperties && s.additionalProperties !== false)
        out[key] = this.parse(s.additionalProperties, item, [...path, key]);
      else
        throw new ShapeError(
          pointer([...path, key]),
          `unknown field \`${key}\`, expected ${expectedList(Object.keys(properties))}`,
        );
    }
    for (const name of s.required ?? [])
      if (!(name in input)) throw new ShapeError(pointer(path), `missing field \`${name}\``);
    for (const [key, field] of Object.entries(properties)) {
      const resolved = this.resolve(field);
      const fallback = field.default ?? resolved?.default;
      if (!(key in input) && fallback !== undefined) out[key] = structuredClone(fallback);
    }
    return out;
  }

  /** An internally tagged enum: objects told apart by their `signal` constant. */
  private tagged(branches: Schema[], value: unknown, path: string[]): unknown {
    const tag =
      Object.keys(branches[0].properties).find(
        (k) => branches[0].properties[k].const !== undefined,
      ) ?? "signal";
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new ShapeError(
        pointer(path),
        `invalid type: ${describeValue(value)}, expected internally tagged enum`,
      );
    const names = branches.map((b) => b.properties[tag].const as string);
    const signal = (value as Record<string, unknown>)[tag];
    if (signal === undefined) throw new ShapeError(pointer(path), `missing field \`${tag}\``);
    const branch = branches.find((b) => b.properties[tag].const === signal);
    if (!branch)
      throw new ShapeError(
        pointer([...path, tag]),
        typeof signal === "string"
          ? `unknown variant \`${signal}\`, expected ${expectedList(names)}`
          : `invalid type: ${describeValue(signal)}, expected ${expectedList(names)}`,
      );
    return this.object(branch, value, path);
  }
}
