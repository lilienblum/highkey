export type Signal = "events" | "logs" | "dashboards";

export interface ChangeEnvelope {
  version: 2;
  changes: { product: string; signals: Signal[] }[] | null;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const signals: readonly string[] = ["events", "logs", "dashboards"];
const isSignal = (value: unknown): value is Signal =>
  typeof value === "string" && signals.includes(value);

function hasOnly(body: Record<string, unknown>, ...keys: string[]) {
  return Object.keys(body).every((key) => keys.includes(key));
}

// The API and dashboard deploy separately, so both v1 and v2 hints are accepted. A v1 hint
// only ever meant event changes.
export function parseChangeEnvelope(value: unknown): ChangeEnvelope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.version === 1) {
    if (!hasOnly(body, "version", "products")) return null;
    if (body.products === null) return { version: 2, changes: null };
    if (!Array.isArray(body.products) || body.products.length < 1 || body.products.length > 64)
      return null;
    if (!body.products.every((id) => typeof id === "string" && uuid.test(id))) return null;
    return {
      version: 2,
      changes: [...new Set(body.products.map((id: string) => id.toLowerCase()))].map((product) => ({
        product,
        signals: ["events"],
      })),
    };
  }
  if (body.version !== 2 || !hasOnly(body, "version", "changes")) return null;
  if (body.changes === null) return { version: 2, changes: null };
  if (!Array.isArray(body.changes) || body.changes.length < 1 || body.changes.length > 64)
    return null;
  const changes: { product: string; signals: Signal[] }[] = [];
  for (const entry of body.changes) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const change = entry as Record<string, unknown>;
    if (!hasOnly(change, "product", "signals")) return null;
    if (typeof change.product !== "string" || !uuid.test(change.product)) return null;
    if (!Array.isArray(change.signals) || change.signals.length < 1 || change.signals.length > 3)
      return null;
    if (!change.signals.every(isSignal)) return null;
    changes.push({
      product: change.product.toLowerCase(),
      signals: [...new Set(change.signals)],
    });
  }
  return { version: 2, changes };
}

/** A full resync (`changes: null`) matches every product and signal. */
export function matches(envelope: ChangeEnvelope, product: string, wanted: Signal[]): boolean {
  if (envelope.changes === null) return true;
  return envelope.changes.some(
    (change) => change.product === product && change.signals.some((s) => wanted.includes(s)),
  );
}
