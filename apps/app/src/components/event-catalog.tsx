import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useEventCatalog } from "@/lib/use-event-catalog";
import { eventColors, type EventDefinition } from "@/lib/event-catalog";
import { useOrganizationRole } from "./settings/settings-nav";
import { SourceIcon, SourceIconPicker } from "./source-icon";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogHeader,
  DialogTrigger,
} from "./ui/dialog";
import { FieldGroup, Field, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { ErrorState } from "./shared";
import { ValueSelect } from "./value-select";

const blank = (name = ""): EventDefinition => ({
  name,
  icon: "generic",
  color: "neutral",
  description: "",
  sentence: "",
  conversion: false,
});
export function EventCatalog({ id, observed }: { id: string; observed: string[] }) {
  const catalog = useEventCatalog(id),
    client = useQueryClient();
  const editable = useOrganizationRole() !== "viewer";
  const [open, setOpen] = useState(false),
    [draft, setDraft] = useState<EventDefinition>(),
    [tab, setTab] = useState("all");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const names = [...new Set([...observed, ...(catalog.data ?? []).map((d) => d.name)])].sort();
  const byName = new Map(catalog.data?.map((d) => [d.name, d]));
  const list = tab === "conversions" ? names.filter((n) => byName.get(n)?.conversion) : names;
  const set = (patch: Partial<EventDefinition>) =>
    setDraft((prev) => prev && { ...prev, ...patch });
  const save = async (remove = false) => {
    if (!draft || busy) return;
    setBusy(true);
    setError("");
    try {
      await api(
        `/products/${id}/event-catalog`,
        remove ? "DELETE" : "PUT",
        remove ? { name: draft.name } : draft,
      );
      await client.invalidateQueries({ queryKey: ["event-catalog", id] });
      setDraft(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          setDraft(undefined);
          setError("");
        }
      }}
    >
      <DialogTrigger render={<Button variant="outline" />}>Event catalog</DialogTrigger>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {draft ? draft.name || "New event definition" : "Event catalog"}
          </DialogTitle>
          <DialogDescription>
            {draft
              ? "Describe how this event appears in the stream and reports."
              : "Event descriptions and conversion goals for this project."}
          </DialogDescription>
        </DialogHeader>
        {catalog.error && (
          <ErrorState message={catalog.error.message} retry={() => void catalog.refetch()} />
        )}
        {error && <ErrorState message={error} />}
        {draft ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="catalog-name">Event name</FieldLabel>
                <Input
                  id="catalog-name"
                  required
                  maxLength={64}
                  value={draft.name}
                  onChange={(e) => set({ name: e.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="catalog-description">Description</FieldLabel>
                <Input
                  id="catalog-description"
                  maxLength={512}
                  value={draft.description}
                  onChange={(e) => set({ description: e.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="catalog-sentence">Sentence template</FieldLabel>
                <Input
                  id="catalog-sentence"
                  placeholder="Order {order_id} shipped"
                  maxLength={256}
                  value={draft.sentence}
                  onChange={(e) => set({ sentence: e.target.value })}
                />
              </Field>
              <div className="flex gap-3 items-end">
                <SourceIconPicker
                  name={draft.name}
                  value={draft.icon}
                  onChange={(icon) => set({ icon: icon ?? "generic" })}
                />
                <Field>
                  <FieldLabel htmlFor="catalog-color">Color</FieldLabel>
                  <ValueSelect
                    id="catalog-color"
                    value={draft.color}
                    options={eventColors.map((v) => [v, v])}
                    onValueChange={(v) => set({ color: v as EventDefinition["color"] })}
                  />
                </Field>
              </div>
              <Field orientation="horizontal">
                <Switch
                  id="catalog-conversion"
                  checked={draft.conversion}
                  onCheckedChange={(conversion) => set({ conversion })}
                />
                <FieldLabel htmlFor="catalog-conversion">Count as a conversion</FieldLabel>
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button disabled={busy} type="submit">
                  Save definition
                </Button>
                <Button variant="outline" type="button" onClick={() => setDraft(undefined)}>
                  Cancel
                </Button>
                {byName.has(draft.name) && (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void save(true)}
                  >
                    Remove definition
                  </Button>
                )}
              </div>
            </FieldGroup>
          </form>
        ) : (
          <>
            <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
              <TabsList aria-label="Catalog events" variant="line">
                <TabsTrigger value="all">Events</TabsTrigger>
                <TabsTrigger value="conversions">Conversions</TabsTrigger>
              </TabsList>
              <TabsContent value={tab}>
                <ul className="divide-y">
                  {list.map((name) => {
                    const def = byName.get(name) ?? blank(name);
                    return (
                      <li className="flex flex-wrap gap-2 items-center py-2" key={name}>
                        <span className={`event-ink-${def.color}`}>
                          <SourceIcon name={name} icon={def.icon} />
                        </span>
                        <div className="flex-1 min-w-0 break-all">
                          {name}
                          {def.description && (
                            <p className="text-muted-foreground text-xs">{def.description}</p>
                          )}
                        </div>
                        {def.conversion && <small>Conversion</small>}
                        {editable && (
                          <Button
                            variant="ghost"
                            aria-label={`Edit ${name}`}
                            onClick={() => setDraft({ ...def })}
                          >
                            Edit
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {!list.length && (
                  <p>
                    {tab === "conversions"
                      ? "No events marked as conversions."
                      : "No events in this selection."}
                  </p>
                )}
              </TabsContent>
            </Tabs>
            {editable && (
              <Button variant="outline" onClick={() => setDraft(blank())}>
                New definition
              </Button>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
