import { useId, useRef, useState, type FormEvent, type RefObject } from "react";
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

/**
 * Asks for a name and runs `onSubmit` with it, for saving a dashboard copy, a view or a new name.
 * A rejected submit shows its message under the field and keeps the dialog open. The form
 * remounts on each open, so it never keeps a stale name or error.
 */
export function NameDialog({
  open,
  onOpenChange,
  title,
  description,
  initialName,
  submitLabel,
  onSubmit,
  failure = "Could not save.",
  finalFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  initialName: string;
  submitLabel: string;
  /** Saves under the chosen name; the dialog closes when it resolves. */
  onSubmit: (name: string) => Promise<void>;
  /** The message for a failure that carries none of its own. */
  failure?: string;
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
          onSubmit={onSubmit}
          failure={failure}
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
  onSubmit,
  failure,
  busy,
  setBusy,
  onDone,
}: {
  title: string;
  description: string;
  initialName: string;
  submitLabel: string;
  onSubmit: (name: string) => Promise<void>;
  failure: string;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const errorId = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit(name.trim());
      onDone();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : failure);
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
        <Button type="submit" disabled={busy}>
          {busy && <Spinner data-icon="inline-start" aria-hidden="true" />}
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}
