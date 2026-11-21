import type { SourceIconId } from "./source-icons";
export const eventColors = ["neutral", "yellow", "violet", "aqua", "green", "red"] as const;
export type CustomClause = {
  event: string;
  filters: { property: string; op: string; value?: string | number | boolean }[];
};
export type EventDefinition = {
  name: string;
  icon: SourceIconId;
  color: (typeof eventColors)[number];
  description: string;
  sentence: string;
  conversion: boolean;
  rules?: CustomClause[];
};
export function eventSentence(template: string, properties: Record<string, unknown>) {
  return template.replace(/\{([a-zA-Z0-9_./-]{1,64})\}/g, (_match, k: string) => {
    const v = Object.hasOwn(properties, k) ? properties[k] : undefined;
    return typeof v === "string" || typeof v === "boolean" || typeof v === "number"
      ? String(v)
      : "—";
  });
}
