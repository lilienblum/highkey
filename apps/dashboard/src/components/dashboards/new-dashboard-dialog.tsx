import { useId, useState, type FormEvent, type RefObject } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  DocumentError,
  blankDocument,
  createDashboard,
  overviewTemplate,
  type StoredDashboard,
} from "@/lib/dashboards";
import { workspaceTarget } from "@/lib/workspace-route";
import { useWorkspace } from "../app-shell";

export type DashboardTemplate = "blank" | "overview";

/** Opens a dashboard that was just created, after the sidebar has learned about it. */
export function useOpenDashboard() {
  const navigate = useNavigate();
  const { product, reload } = useWorkspace();
  return async (stored: StoredDashboard) => {
    await reload();
    if (product) await navigate(workspaceTarget("/dashboards", product.slug, stored.slug));
  };
}

/** A failed create reads as the API's first complaint about the document, else the error itself. */
export function createErrorMessage(error: unknown): string {
  if (error instanceof DocumentError && error.issues[0]) return error.issues[0].message;
  return error instanceof Error ? error.message : "Could not create the dashboard.";
}

/**
 * Names a new dashboard and starts it blank or as an editable copy of Overview. The form remounts
 * on each open, so it never keeps a stale name or error.
 */
export function NewDashboardDialog({
  open,
  onOpenChange,
  initialTemplate = "blank",
  finalFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTemplate?: DashboardTemplate;
  /** Where focus returns on close when the opener is gone (a menu item). */
  finalFocus?: RefObject<HTMLElement | null>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent showCloseButton={!busy} finalFocus={finalFocus}>
        <NewDashboardForm
          initialTemplate={initialTemplate}
          busy={busy}
          setBusy={setBusy}
          onDone={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function NewDashboardForm({
  initialTemplate,
  busy,
  setBusy,
  onDone,
}: {
  initialTemplate: DashboardTemplate;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onDone: () => void;
}) {
  const { product } = useWorkspace();
  const open = useOpenDashboard();
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<DashboardTemplate>(initialTemplate);
  const [error, setError] = useState("");
  const nameId = useId();
  const errorId = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!product || busy) return;
    const title = name.trim();
    setBusy(true);
    setError("");
    try {
      const document = template === "overview" ? overviewTemplate(title) : blankDocument(title);
      const stored = await createDashboard(product.id, document);
      onDone();
      await open(stored);
    } catch (e) {
      setError(createErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-5">
      <DialogHeader>
        <DialogTitle>New dashboard</DialogTitle>
        <DialogDescription>
          Dashboards hold widgets over this project’s events and logs.
        </DialogDescription>
      </DialogHeader>
      <Field data-invalid={error ? true : undefined}>
        <FieldLabel htmlFor={nameId}>Name</FieldLabel>
        <Input
          id={nameId}
          value={name}
          autoComplete="off"
          autoFocus
          disabled={busy}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => setName(e.target.value)}
        />
        {error && <FieldError id={errorId}>{error}</FieldError>}
      </Field>
      <Field>
        <FieldLabel id={`${nameId}-template`}>Start from</FieldLabel>
        <ToggleGroup
          variant="outline"
          spacing={0}
          aria-labelledby={`${nameId}-template`}
          value={[template]}
          disabled={busy}
          onValueChange={(next) => {
            const chosen = next[0] as DashboardTemplate | undefined;
            if (chosen) setTemplate(chosen);
          }}
        >
          <ToggleGroupItem value="blank">Blank</ToggleGroupItem>
          <ToggleGroupItem value="overview">Start from Overview</ToggleGroupItem>
        </ToggleGroup>
      </Field>
      <DialogFooter>
        <Button type="submit" disabled={busy || !product}>
          {busy && <Spinner data-icon="inline-start" aria-hidden="true" />}
          {busy ? "Creating…" : "Create dashboard"}
        </Button>
      </DialogFooter>
    </form>
  );
}
