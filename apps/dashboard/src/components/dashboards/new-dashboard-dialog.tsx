import { useId, useRef, useState, type FormEvent, type RefObject } from "react";
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
import {
  DocumentError,
  createDashboard,
  type DashboardDocument,
  type StoredDashboard,
} from "@/lib/dashboards";
import { workspaceTarget } from "@/lib/workspace-route";
import { Spinner } from "@/components/ui/spinner";
import { useWorkspace } from "../app-shell";

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
 * Names a copy of a dashboard and opens it. The form remounts on each open, so it never keeps a
 * stale name or error.
 */
export function NameDialog({
  open,
  onOpenChange,
  title,
  description,
  initialName,
  submitLabel,
  build,
  finalFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  initialName: string;
  submitLabel: string;
  /** The document to save under the chosen name. */
  build: (name: string) => DashboardDocument;
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
        <NameForm
          title={title}
          description={description}
          initialName={initialName}
          submitLabel={submitLabel}
          build={build}
          busy={busy}
          setBusy={setBusy}
          onDone={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function NameForm({
  title,
  description,
  initialName,
  submitLabel,
  build,
  busy,
  setBusy,
  onDone,
}: {
  title: string;
  description: string;
  initialName: string;
  submitLabel: string;
  build: (name: string) => DashboardDocument;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onDone: () => void;
}) {
  const { product } = useWorkspace();
  const open = useOpenDashboard();
  const [name, setName] = useState(initialName);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const errorId = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!product || busy) return;
    setBusy(true);
    setError("");
    try {
      const stored = await createDashboard(product.id, build(name.trim()));
      onDone();
      await open(stored);
    } catch (e) {
      setError(createErrorMessage(e));
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-5">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <Field data-invalid={error ? true : undefined}>
        <FieldLabel htmlFor={nameId}>Name</FieldLabel>
        <Input
          ref={input}
          id={nameId}
          value={name}
          autoComplete="off"
          autoFocus
          readOnly={busy}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setName(e.target.value)}
        />
        {error && <FieldError id={errorId}>{error}</FieldError>}
      </Field>
      <DialogFooter>
        <Button type="submit" disabled={busy || !product}>
          {busy && <Spinner data-icon="inline-start" aria-hidden="true" />}
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}
