export const filterOps = [
  ["eq", "equals"],
  ["ne", "does not equal"],
  ["gt", "greater than"],
  ["gte", "at least"],
  ["lt", "less than"],
  ["lte", "at most"],
  ["contains", "contains"],
  ["not_contains", "does not contain"],
  ["starts_with", "starts with"],
  ["ends_with", "ends with"],
  ["regex", "matches regex"],
  ["empty", "is empty"],
  ["not_empty", "is not empty"],
  ["exists", "is present"],
  ["not_exists", "is absent"],
] as const;
export const unaryFilter = (op: string) =>
  ["exists", "not_exists", "empty", "not_empty"].includes(op);
export const textFilter = (op: string) =>
  ["contains", "not_contains", "starts_with", "ends_with", "regex"].includes(op);
export const supportedOp = (op: string) => filterOps.some(([v]) => v === op);
export const validRegex = (v: string) => {
  if (!v || new TextEncoder().encode(v).length > 256 || /\\[1-9]|\(\?[=!<]/.test(v)) return false;
  try {
    new RegExp(v);
    return true;
  } catch {
    return false;
  }
};
