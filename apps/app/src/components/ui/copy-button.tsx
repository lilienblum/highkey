import * as React from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type CopyState = "idle" | "copied" | "failed";

type CopyButtonProps = Omit<React.ComponentProps<typeof Button>, "content" | "onClick"> & {
  /** The text to copy. */
  content: string;
  /** How long the check (or the cross) stays, in milliseconds. */
  resetDelay?: number;
  /** Announced after a copy lands. */
  copiedLabel?: string;
  /** Announced when the clipboard refuses. */
  failedLabel?: string;
  /** Called when the clipboard refuses, to offer another way to get the text. */
  onCopyError?: (error: unknown) => void;
};

/**
 * Copies `content` and swaps its icon for a check for a few seconds, or for a cross when the
 * clipboard refuses. Icon-only by default (give it an `aria-label` that says what it copies);
 * children make it a labelled button. Its polite status sits beside it, so a label's accessible
 * name never changes.
 */
export function CopyButton({
  content,
  resetDelay = 3000,
  copiedLabel = "Copied",
  failedLabel = "Couldn’t copy",
  onCopyError,
  children,
  className,
  variant = "outline",
  size,
  ...props
}: CopyButtonProps) {
  const [state, setState] = React.useState<CopyState>("idle");
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    let next: CopyState = "copied";
    try {
      await navigator.clipboard.writeText(content);
    } catch (error) {
      next = "failed";
      onCopyError?.(error);
    }
    clearTimeout(timer.current);
    setState(next);
    timer.current = setTimeout(() => setState("idle"), resetDelay);
  }
  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size ?? (children ? "sm" : "icon-sm")}
        data-slot="copy-button"
        data-state={state}
        className={cn("copy-button has-[>[data-slot=copy-button-icon]]:px-2.5", className)}
        onClick={() => void copy()}
        {...props}
      >
        <span data-slot="copy-button-icon" className="copy-button-icon" aria-hidden="true">
          <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} data-copy="idle" />
          <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} data-copy="copied" />
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} data-copy="failed" />
        </span>
        {children}
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {state === "copied" ? copiedLabel : state === "failed" ? failedLabel : ""}
      </span>
    </>
  );
}
