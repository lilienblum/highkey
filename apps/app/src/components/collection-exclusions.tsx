import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Exclusions } from "@/server/exclusions";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ValueSelect } from "./value-select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";
import { oversees, useOrganizationRole } from "./settings/settings-nav";
export function CollectionExclusions({ id }: { id: string }) {
  const role = useOrganizationRole(),
    [open, setOpen] = useState(false),
    [draft, setDraft] = useState<Exclusions>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const stored = useQuery({
    queryKey: ["exclusions", id],
    enabled: open && oversees(role),
    queryFn: ({ signal }) =>
      api<Exclusions>(`/products/${id}/exclusions`, "GET", undefined, signal),
  });
  const value = draft ?? stored.data,
    patch = (v: Partial<Exclusions>) => {
      if (value) setDraft({ ...value, ...v });
    };
  if (!oversees(role)) return null;
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        setDraft(undefined);
        setError("");
      }}
    >
      <DialogTrigger render={<Button variant="outline" className="w-fit" />}>
        Collection exclusions
      </DialogTrigger>
      <DialogContent className="max-h-[85dvh] overflow-auto grid-cols-[minmax(0,1fr)]">
        <DialogHeader>
          <DialogTitle>Collection exclusions</DialogTitle>
          <DialogDescription>
            Discard matching incoming events and identity updates. Rules apply to this project
            within five seconds of reaching the collector.
          </DialogDescription>
        </DialogHeader>
        {stored.error && <p role="alert">{stored.error.message}</p>}
        {value && (
          <form
            className="grid gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              if (busy) return;
              setBusy(true);
              setError("");
              try {
                await api(`/products/${id}/exclusions`, "PUT", {
                  ...value,
                  networks: value.networks.map((s) => s.trim()).filter(Boolean),
                  profiles: value.profiles.map((s) => s.trim()).filter(Boolean),
                });
                await stored.refetch();
                setOpen(false);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {(["networks", "profiles"] as const).map((k) => (
              <label key={k}>
                {k === "networks" ? "IP networks (CIDR)" : "Profile IDs"}, one per line
                <textarea
                  className="block min-h-16 w-full rounded-md border bg-background p-2"
                  value={value[k].join("\n")}
                  onChange={(e) => patch({ [k]: e.target.value.split("\n") })}
                />
              </label>
            ))}
            {value.rules.map((rule, i) => {
              const set = (p: Partial<typeof rule>) =>
                patch({ rules: value.rules.map((r, j) => (i === j ? { ...r, ...p } : r)) });
              return (
                <fieldset className="grid gap-2 rounded-md border p-3" key={i}>
                  <legend>Event rule {i + 1}</legend>
                  <Input
                    aria-label="Raw event name"
                    value={rule.event}
                    placeholder="Any event"
                    onChange={(e) => set({ event: e.target.value })}
                  />
                  <Input
                    aria-label="Property key"
                    placeholder="Optional property, e.g. path"
                    value={rule.property}
                    onChange={(e) => set({ property: e.target.value })}
                  />
                  {rule.property && (
                    <>
                      <ValueSelect
                        label="Match property"
                        value={rule.op}
                        options={[
                          ["eq", "equals"],
                          ["contains", "contains"],
                          ["starts_with", "starts with"],
                          ["ends_with", "ends with"],
                        ]}
                        onValueChange={(op) => set({ op })}
                      />
                      <Input
                        aria-label="Property value"
                        value={String(rule.value ?? "")}
                        onChange={(e) => {
                          let v = e.target.value;
                          if (rule.op === "eq") {
                            try {
                              const t = JSON.parse(v);
                              if (typeof t === "boolean" || typeof t === "number") {
                                set({ value: t });
                                return;
                              }
                            } catch {}
                          }
                          set({ value: v });
                        }}
                      />
                    </>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => patch({ rules: value.rules.filter((_, n) => n !== i) })}
                  >
                    Remove rule
                  </Button>
                </fieldset>
              );
            })}
            <Button
              type="button"
              variant="outline"
              disabled={value.rules.length >= 32}
              onClick={() =>
                patch({
                  rules: [...value.rules, { event: "", property: "", op: "eq", value: null }],
                })
              }
            >
              Add event rule
            </Button>
            {error && <p role="alert">{error}</p>}
            <Button type="submit" disabled={busy}>
              Save exclusions
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
