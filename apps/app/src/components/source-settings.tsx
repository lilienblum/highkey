import { useState, type FormEvent } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, Edit02Icon } from "@hugeicons/core-free-icons";
import { api, type Product, type Source } from "@/lib/api";
import { useWorkspace } from "./app-shell";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";
import { SourceIcon, SourceIconPicker } from "./source-icon";
import type { SourceIconId } from "@/lib/source-icons";
import { ErrorState } from "./shared";
import { ValueSelect } from "./value-select";
import { useOrganizationSlug } from "@/lib/workspace-route";
import { parseWebsites, ProjectWebsites } from "./project-websites";

export function SourceSettings({ product }: { product: Product }) {
  const { reload } = useWorkspace();
  const org = useOrganizationSlug();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Source>();
  const [draft, setDraft] = useState<SourceDraft>({
    name: "",
    icon: null,
  });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  function show(source?: Source) {
    setEditing(source);
    setDraft(
      source
        ? {
            name: source.name,
            icon: source.icon,
            visitor_mode: source.visitor_mode,
            websites: source.website_urls?.join("\n") ?? "",
          }
        : { name: "", icon: null },
    );
    setSaved(false);
    setError("");
    setOpen(true);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    let committed = saved;
    try {
      if (!committed) {
        await api(
          `/products/${product.id}/sources${editing ? `/${editing.id}` : ""}`,
          editing ? "PATCH" : "POST",
          sourceInput(draft),
        );
        committed = true;
        setSaved(true);
      }
      await reload();
      setOpen(false);
    } catch (error) {
      setError(
        `${committed ? "Source saved. Could not refresh the workspace. " : ""}${(error as Error).message}`,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="sources-card">
      <CardHeader>
        <div className="card-heading">
          <div>
            <CardTitle>Sources</CardTitle>
            <CardDescription>
              Websites, mobile apps, and tools feeding one project. Each source has its own keys.
            </CardDescription>
          </div>
          <Button variant="outline" onClick={() => show()}>
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden="true" />
            Add source
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="source-list">
          {(product.sources ?? []).map((source) => (
            <div className="source-row" key={source.id}>
              <span className="source-mark">
                <SourceIcon name={source.name} icon={source.icon} />
              </span>
              <div className="source-copy">
                <strong>{source.name}</strong>
                {org && (
                  <a
                    className="text-xs text-primary hover:underline"
                    href={`/${encodeURIComponent(org)}/${encodeURIComponent(product.slug)}/settings?source=${encodeURIComponent(source.slug)}#install-guide`}
                  >
                    View SDK install guide
                  </a>
                )}
              </div>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Edit source ${source.name}`}
                onClick={() => show(source)}
              >
                <HugeiconsIcon icon={Edit02Icon} strokeWidth={2} aria-hidden="true" />
                Edit
              </Button>
            </div>
          ))}
        </div>
        <p className="quiet">
          Use All sources for a combined view, or select one in Overview and Events. Retention
          belongs to the project.
        </p>
      </CardContent>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <DialogContent showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit source" : "Add a source"}</DialogTitle>
            <DialogDescription>
              A named integration within {product.name}. No URL or device identity required.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={save} aria-busy={busy}>
            <FieldGroup>
              <SourceFields value={draft} onChange={setDraft} disabled={busy || saved} />
            </FieldGroup>
            {error && <ErrorState message={error} />}
            <Button type="submit" className="mt-6" disabled={busy}>
              {busy && <Spinner aria-hidden="true" />}
              {busy
                ? "Saving…"
                : saved
                  ? "Retry loading source"
                  : editing
                    ? "Save source"
                    : "Create source"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export type SourceDraft = {
  websites?: string;
  name: string;
  icon: SourceIconId | null;
  visitor_mode?: Source["visitor_mode"];
};
export function sourceInput({ websites, name, ...rest }: SourceDraft) {
  return { ...rest, name: name.trim(), website_urls: parseWebsites(websites ?? "") };
}

/**
 * A source's name and icon, as adding or editing one asks for them: the icon follows the name
 * until one is chosen. The settings dialog and the new-project page share it.
 */
export function SourceFields({
  value,
  onChange,
  disabled,
  label = "Source name",
  hint,
}: {
  value: SourceDraft;
  onChange: (value: SourceDraft) => void;
  disabled?: boolean;
  label?: string;
  hint?: string;
}) {
  return (
    <div className="@container grid min-w-0 gap-4">
      <div className="grid items-start gap-4 @min-[32rem]:grid-cols-[minmax(0,22rem)_minmax(0,14rem)]">
        <Field className="min-w-0 max-w-[22rem]" data-disabled={disabled}>
          <FieldLabel htmlFor="source-name">{label}</FieldLabel>
          <div className="relative">
            <Input
              id="source-name"
              className="pe-11"
              value={value.name}
              onChange={(e) => onChange({ ...value, name: e.target.value })}
              placeholder="e.g. Website"
              aria-describedby={hint ? "source-name-hint" : undefined}
              required
              maxLength={80}
              disabled={disabled}
            />
            <SourceIconPicker
              name={value.name}
              value={value.icon}
              onChange={(icon) => onChange({ ...value, icon })}
              disabled={disabled}
              className="absolute end-1 top-1/2 -translate-y-1/2"
            />
          </div>
          {hint ? <FieldDescription id="source-name-hint">{hint}</FieldDescription> : null}
        </Field>
        <Field className="min-w-0 max-w-56">
          <FieldLabel htmlFor="visitor-mode">Visitor counting</FieldLabel>
          <ValueSelect
            id="visitor-mode"
            value={value.visitor_mode ?? "off"}
            onValueChange={(v) =>
              onChange({
                ...value,
                visitor_mode: v as Source["visitor_mode"],
              })
            }
            disabled={disabled}
            options={[
              ["off", "Don’t count visitors"],
              ["cookieless", "Daily visitors"],
              ["persistent", "Returning visitors"],
            ]}
          />
          <FieldDescription>
            {value.visitor_mode === "persistent"
              ? "Recognizes the same browser on later visits, with permission."
              : value.visitor_mode === "cookieless"
                ? "Counts visitors without storing anything on their device. Someone who returns another day counts again."
                : "Page views and other events are still counted."}
          </FieldDescription>
        </Field>
      </div>
      <ProjectWebsites
        id="source-websites"
        value={value.websites ?? ""}
        disabled={disabled}
        onChange={(e) => onChange({ ...value, websites: e.target.value })}
      />
    </div>
  );
}
