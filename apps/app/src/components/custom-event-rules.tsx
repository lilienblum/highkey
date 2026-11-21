import type { CustomClause } from "@/lib/event-catalog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ValueSelect } from "./value-select";

import { filterOps as ops, unaryFilter as unary, textFilter } from "@/lib/filter-ops";
export function typedRules(rules: CustomClause[]): CustomClause[] {
  return rules.map((rule) => ({
    ...rule,
    filters: rule.filters.map(({ property, op, value }) => {
      if (unary(op)) return { property, op };
      const text = String(value ?? "");
      if (textFilter(op)) return { property, op, value: text };
      let scalar = value ?? "";
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === "string" || typeof parsed === "boolean" || typeof parsed === "number")
          scalar = parsed;
      } catch {}
      return { property, op, value: scalar };
    }),
  }));
}
export function CustomEventRules({
  rules,
  change,
  observed,
}: {
  rules: CustomClause[];
  change: (rules: CustomClause[]) => void;
  observed: string[];
}) {
  const update = (i: number, patch: Partial<CustomClause>) =>
    change(rules.map((rule, n) => (n === i ? { ...rule, ...patch } : rule)));
  return (
    <div className="grid gap-3">
      <p>Match any alternative. Within an alternative, every filter must match.</p>
      <datalist id="raw-event-names">
        {observed
          .filter((n) => !n.startsWith("@"))
          .map((n) => (
            <option key={n} value={n} />
          ))}
      </datalist>
      {rules.map((r, i) => (
        <fieldset key={i} className="grid gap-2 min-w-0 rounded-md border p-3">
          <legend>Alternative {i + 1}</legend>
          <Input
            aria-label={`Raw event ${i + 1}`}
            placeholder="page_view"
            list="raw-event-names"
            maxLength={64}
            required
            value={r.event}
            onChange={(e) => update(i, { event: e.target.value })}
          />
          {r.filters.map((f, j) => {
            const set = (patch: Partial<typeof f>) =>
              update(i, { filters: r.filters.map((v, n) => (n === j ? { ...v, ...patch } : v)) });
            return (
              <div key={j} className="grid gap-2 border-t pt-2">
                <Input
                  aria-label={`Property ${i + 1}.${j + 1}`}
                  placeholder="Property, e.g. path"
                  required
                  value={f.property}
                  maxLength={64}
                  onChange={(e) => set({ property: e.target.value })}
                />
                <ValueSelect
                  label={`Comparison ${i + 1}.${j + 1}`}
                  value={f.op}
                  options={ops.map(([k, v]) => [k, v])}
                  onValueChange={(op) => set({ op })}
                />
                {!unary(f.op) && (
                  <Input
                    aria-label={`Value ${i + 1}.${j + 1}`}
                    placeholder="Text, number or boolean"
                    value={String(f.value ?? "")}
                    onChange={(e) => set({ value: e.target.value })}
                  />
                )}
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => update(i, { filters: r.filters.filter((_, n) => n !== j) })}
                >
                  Remove filter
                </Button>
              </div>
            );
          })}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={r.filters.length >= 8}
              onClick={() =>
                update(i, { filters: [...r.filters, { property: "", op: "eq", value: "" }] })
              }
            >
              Add filter
            </Button>
            {rules.length > 1 && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => change(rules.filter((_, n) => n !== i))}
              >
                Remove alternative
              </Button>
            )}
          </div>
        </fieldset>
      ))}
      <Button
        type="button"
        variant="outline"
        disabled={rules.length >= 8}
        onClick={() => change([...rules, { event: "", filters: [] }])}
      >
        Add alternative
      </Button>
    </div>
  );
}
