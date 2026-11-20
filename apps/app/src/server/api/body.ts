// Request bodies: bounded JSON, and field checks that mirror serde's `deny_unknown_fields`
// (422 for an unknown, missing or mistyped field; 400 for malformed JSON).
import { ApiError, unprocessable } from "./errors";

export const MAX_BODY_BYTES = 256 * 1024;

export async function readJson(request: Request, limit = MAX_BODY_BYTES): Promise<unknown> {
  const buffer = new Uint8Array(await request.arrayBuffer());
  if (buffer.byteLength > limit) throw new ApiError(413, "Request body is too large");
  const text = new TextDecoder().decode(buffer);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ApiError(
      400,
      `Failed to parse the request body as JSON: ${error instanceof Error ? error.message : error}`,
    );
  }
}

export type FieldType =
  "string" | "string?" | "number" | "integer" | "boolean" | "string[]" | "string[]?" | "unknown";

type Typed<T extends Record<string, FieldType>> = {
  [K in keyof T]: T[K] extends "string"
    ? string
    : T[K] extends "string?"
      ? string | null | undefined
      : T[K] extends "number" | "integer"
        ? number
        : T[K] extends "boolean"
          ? boolean
          : T[K] extends "string[]"
            ? string[]
            : T[K] extends "string[]?"
              ? string[] | undefined
              : unknown;
};

function matches(type: FieldType, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "string?":
      return value === undefined || value === null || typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "string[]":
      return Array.isArray(value) && value.every((item) => typeof item === "string");
    case "string[]?":
      return (
        value === undefined ||
        (Array.isArray(value) && value.every((item) => typeof item === "string"))
      );
    case "unknown":
      return true;
  }
}

/** Checks an object's fields against `spec`; `defaults` fills optional fields left out. */
export function fields<T extends Record<string, FieldType>>(
  value: unknown,
  spec: T,
  defaults: Partial<Typed<T>> = {},
): Typed<T> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw unprocessable("Expected a JSON object");
  const object = value as Record<string, unknown>;
  for (const name of Object.keys(object))
    if (!(name in spec))
      throw unprocessable(
        `unknown field \`${name}\`, expected one of ${Object.keys(spec)
          .map((field) => `\`${field}\``)
          .join(", ")}`,
      );
  const result: Record<string, unknown> = {};
  for (const [name, type] of Object.entries(spec)) {
    const supplied = object[name];
    const present = supplied !== undefined;
    const optional = type.endsWith("?") || type === "unknown" || name in defaults;
    if (!present && !optional) throw unprocessable(`missing field \`${name}\``);
    const fieldValue = present ? supplied : (defaults as Record<string, unknown>)[name];
    if (present && !matches(type, fieldValue))
      throw unprocessable(`invalid type for field \`${name}\``);
    result[name] = fieldValue;
  }
  return result as Typed<T>;
}
