import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Cohort, CohortDefinition } from "@/server/cohorts";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ValueSelect } from "./value-select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "./ui/dialog";
import { useOrganizationRole } from "./settings/settings-nav";
import { useEventCatalog } from "@/lib/use-event-catalog";
import { filterOps, unaryFilter, textFilter } from "@/lib/filter-ops";
export function useCohorts(id?: string) {
  return useQuery({
    queryKey: ["cohorts", id],
    enabled: !!id,
    staleTime: 30000,
    queryFn: ({ signal }) => api<Cohort[]>(`/products/${id}/cohorts`, "GET", undefined, signal),
  });
}
type Rule = Extract<CohortDefinition, { mode: "dynamic" }>["rules"][number];
export function CohortPicker({
  project,
  value,
  change,
}: {
  project: string;
  value?: string;
  change: (id?: string) => void;
}) {
  const q = useCohorts(project);
  if (!q.data?.length && !value) return null;
  return (
    <ValueSelect
      label="Report cohort"
      className="max-w-xs"
      value={value ?? "*"}
      options={[["*", "All profiles"], ...(q.data ?? []).map((c) => [c.id, c.name] as const)]}
      onValueChange={(v) => change(v === "*" ? undefined : v)}
    />
  );
}
const event = (): Rule => ({ event: "", days: 30, compare: "at_least", count: 1 });
export function Cohorts({ id, select }: { id: string; select: (id: string) => void }) {
  const cohorts = useCohorts(id),
    client = useQueryClient(),
    role = useOrganizationRole(),
    catalog = useEventCatalog(id);
  const [open, setOpen] = useState(false),
    [edit, setEdit] = useState<string>(),
    [name, setName] = useState(""),
    [mode, setMode] = useState("dynamic"),
    [match, setMatch] = useState<"any" | "all">("all"),
    [members, setMembers] = useState(""),
    [rules, setRules] = useState<Rule[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  function start(c?: Cohort) {
    setError("");
    setEdit(c?.id ?? "");
    setName(c?.name ?? "");
    setMode(c?.definition.mode ?? "dynamic");
    setMatch(c?.definition.mode === "dynamic" ? c.definition.match : "all");
    setRules(c?.definition.mode === "dynamic" ? c.definition.rules : [event()]);
    setMembers(c?.definition.mode === "static" ? c.definition.members.join("\n") : "");
  }
  async function save(remove = false) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (remove) await api(`/products/${id}/cohorts/${edit}`, "DELETE");
      else {
        const d: CohortDefinition =
          mode === "static"
            ? {
                mode: "static",
                members: members
                  .split(/\r?\n/)
                  .map((s) => s.trim())
                  .filter(Boolean),
              }
            : {
                mode: "dynamic",
                match,
                rules: rules.map((r) => {
                  if ("event" in r) return r;
                  if (unaryFilter(r.op)) return { property: r.property, op: r.op };
                  let value = r.value;
                  if (!textFilter(r.op) && typeof value === "string") {
                    try {
                      value = JSON.parse(value);
                    } catch {}
                  }
                  return { ...r, value };
                }),
              };
        await api(`/products/${id}/cohorts`, "POST", {
          id: edit || undefined,
          name,
          definition: d,
        });
      }
      await client.invalidateQueries({ queryKey: ["cohorts", id] });
      setEdit(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const update = (i: number, patch: Partial<Rule>) =>
    setRules((rows) => rows.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          setEdit(undefined);
          setError("");
        }
      }}
    >
      <DialogTrigger render={<Button variant="outline" />}>Cohorts</DialogTrigger>
      <DialogContent className="grid-cols-[minmax(0,1fr)] max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {edit === undefined ? "Cohorts" : edit ? "Edit cohort" : "New cohort"}
          </DialogTitle>
          <DialogDescription>
            Fixed lists of profiles, or rules recalculated every 30 minutes.
          </DialogDescription>
        </DialogHeader>
        {edit === undefined ? (
          <>
            {cohorts.error && <p role="alert">{cohorts.error.message}</p>}
            {cohorts.data?.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center gap-2">
                <Button
                  variant="link"
                  onClick={() => {
                    select(c.id);
                    setOpen(false);
                  }}
                >
                  {c.name}
                </Button>
                <span>{c.member_count} members</span>
                {role !== "viewer" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Edit ${c.name}`}
                    onClick={() => start(c)}
                  >
                    Edit
                  </Button>
                )}
              </div>
            ))}
            {!cohorts.data?.length && !cohorts.isFetching && <p>No cohorts yet.</p>}
            {role !== "viewer" && <Button onClick={() => start()}>New cohort</Button>}
          </>
        ) : (
          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label>
              Name
              <Input
                value={name}
                maxLength={80}
                required
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <ValueSelect
              label="Membership"
              value={mode}
              onValueChange={setMode}
              options={[
                ["dynamic", "Rules"],
                ["static", "Static list"],
              ]}
            />
            {mode === "static" ? (
              <label>
                Profile IDs, one per line
                <textarea
                  className="block min-h-28 w-full rounded-md border bg-background p-2"
                  value={members}
                  onChange={(e) => setMembers(e.target.value)}
                />
              </label>
            ) : (
              <>
                <ValueSelect
                  label="Match rules"
                  value={match}
                  onValueChange={(v) => setMatch(v as "all" | "any")}
                  options={[
                    ["all", "Match all rules"],
                    ["any", "Match any rule"],
                  ]}
                />
                <datalist id="cohort-event-options">
                  {catalog.data?.map((d) => (
                    <option key={d.name} value={d.name} />
                  ))}
                </datalist>
                {rules.map((r, i) => (
                  <fieldset key={i} className="grid min-w-0 gap-2 rounded-md border p-3">
                    <legend>
                      {i + 1}. {"event" in r ? "Event count" : "Profile property"}
                    </legend>
                    {"event" in r ? (
                      <>
                        <Input
                          aria-label="Event name"
                          list="cohort-event-options"
                          placeholder="Event or @custom"
                          value={r.event}
                          required
                          maxLength={65}
                          onChange={(e) => update(i, { event: e.target.value })}
                        />
                        <ValueSelect
                          label="Compare count"
                          value={r.compare}
                          onValueChange={(v) =>
                            update(i, { compare: v as "at_least" | "at_most" | "exactly" })
                          }
                          options={[
                            ["at_least", "At least"],
                            ["exactly", "Exactly"],
                            ["at_most", "At most"],
                          ]}
                        />
                        <label>
                          Times
                          <Input
                            required
                            type="number"
                            min={0}
                            max={1000000}
                            value={r.count}
                            onChange={(e) => update(i, { count: e.target.valueAsNumber })}
                          />
                        </label>
                        <label>
                          In the last (days)
                          <Input
                            required
                            type="number"
                            min={7}
                            max={365}
                            value={r.days}
                            onChange={(e) => update(i, { days: e.target.valueAsNumber })}
                          />
                        </label>
                      </>
                    ) : (
                      <>
                        <Input
                          required
                          aria-label="Profile property"
                          value={r.property}
                          onChange={(e) => update(i, { property: e.target.value })}
                        />
                        <ValueSelect
                          label="Property condition"
                          value={r.op}
                          onValueChange={(v) => update(i, { op: v })}
                          options={filterOps}
                        />
                        {!unaryFilter(r.op) && (
                          <Input
                            aria-label="Trait value"
                            value={String(r.value ?? "")}
                            onChange={(e) => update(i, { value: e.target.value })}
                          />
                        )}
                      </>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={rules.length === 1}
                      onClick={() => setRules(rules.filter((_, j) => j !== i))}
                    >
                      Remove rule
                    </Button>
                  </fieldset>
                ))}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={rules.length >= 8}
                    onClick={() => setRules([...rules, event()])}
                  >
                    Add event rule
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={rules.length >= 8}
                    onClick={() => setRules([...rules, { property: "", op: "eq", value: "" }])}
                  >
                    Add trait rule
                  </Button>
                </div>
              </>
            )}
            {error && <p role="alert">{error}</p>}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy}>
                Save cohort
              </Button>
              <Button type="button" variant="outline" onClick={() => setEdit(undefined)}>
                Cancel
              </Button>
              {edit && (
                <Button
                  type="button"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => void save(true)}
                >
                  Delete cohort
                </Button>
              )}
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
