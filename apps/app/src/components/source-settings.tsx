import { useEffect, useRef, useState, type FormEvent } from "react";
import { mountConsentPrompt } from "../../../../sdk/typescript/consent-ui";
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

export function SourceSettings({ product }: { product: Product }) {
  const { reload } = useWorkspace();
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
            consent_prompt: source.consent_prompt,
            consent_theme: source.consent_theme,
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
          draft,
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
  name: string;
  icon: SourceIconId | null;
  visitor_mode?: Source["visitor_mode"];
  consent_prompt?: Source["consent_prompt"];
  consent_theme?: Source["consent_theme"];
};

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
    <>
      <Field data-disabled={disabled}>
        <FieldLabel htmlFor="source-name">{label}</FieldLabel>
        <div className="relative">
          <Input
            id="source-name"
            className="pe-11"
            value={value.name}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
            placeholder="e.g. Website, iOS app, CLI"
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
      <Field>
        <FieldLabel htmlFor="visitor-mode">Visitor counting</FieldLabel>
        <ValueSelect
          id="visitor-mode"
          value={value.visitor_mode ?? "off"}
          onValueChange={(v) =>
            onChange({
              ...value,
              visitor_mode: v as Source["visitor_mode"],
              consent_prompt: value.consent_prompt ?? (v === "persistent" ? "bar" : undefined),
            })
          }
          disabled={disabled}
          options={[
            ["off", "Off"],
            ["cookieless", "Daily visitors"],
            ["persistent", "Returning visitors"],
          ]}
        />
        <FieldDescription>
          {value.visitor_mode === "persistent"
            ? "Recognizes the same browser on later visits, with permission."
            : value.visitor_mode === "cookieless"
              ? "Counts visitors without storing anything on their device. Someone who returns another day counts again."
              : "Counts events without counting visitors."}
        </FieldDescription>
      </Field>
      {value.visitor_mode === "persistent" && (
        <>
          <Field>
            <FieldLabel htmlFor="source-consent">Who asks for permission?</FieldLabel>
            <ValueSelect
              id="source-consent"
              value={value.consent_prompt === "site" ? "site" : "highkey"}
              disabled={disabled}
              options={[
                ["highkey", "Ask with Highkey"],
                ["site", "My site already asks"],
              ]}
              onValueChange={(v) =>
                onChange({ ...value, consent_prompt: v === "site" ? "site" : "bar" })
              }
            />
            <FieldDescription>
              {value.consent_prompt === "site"
                ? "Start the tracker only after your visitor agrees."
                : "Visitors can decline and keep using your site. Copy the updated browser snippet to use this prompt."}
            </FieldDescription>
          </Field>
          {value.consent_prompt !== "site" && (
            <div className="grid gap-3">
              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel htmlFor="source-consent-layout">Layout</FieldLabel>
                  <ValueSelect
                    id="source-consent-layout"
                    disabled={disabled}
                    value={value.consent_prompt ?? "bar"}
                    options={[
                      ["bar", "Bottom bar"],
                      ["corner", "Corner card"],
                    ]}
                    onValueChange={(v) =>
                      onChange({ ...value, consent_prompt: v as Source["consent_prompt"] })
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="source-consent-theme">Theme</FieldLabel>
                  <ValueSelect
                    id="source-consent-theme"
                    disabled={disabled}
                    value={value.consent_theme ?? "auto"}
                    options={[
                      ["auto", "Match site"],
                      ["light", "Light"],
                      ["dark", "Dark"],
                    ]}
                    onValueChange={(v) =>
                      onChange({ ...value, consent_theme: v as Source["consent_theme"] })
                    }
                  />
                </Field>
              </div>
              <ConsentPreview
                layout={value.consent_prompt ?? "bar"}
                theme={value.consent_theme ?? "auto"}
              />
            </div>
          )}
        </>
      )}
    </>
  );
}
function ConsentPreview({
  layout,
  theme,
}: {
  layout: "bar" | "corner";
  theme: "auto" | "light" | "dark";
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const panel = mountConsentPrompt(ref.current!, { layout, theme }, () => {}, null, true);
    return () => panel.remove();
  }, [layout, theme]);
  return (
    <figure>
      <figcaption className="mb-2 text-xs text-muted-foreground">Prompt preview</figcaption>
      <div ref={ref} />
    </figure>
  );
}
