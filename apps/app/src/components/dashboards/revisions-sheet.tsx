import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { ApiError } from "@/lib/api";
import {
  listRevisions,
  restoreRevision,
  type Issue,
  type RevisionInfo,
  type DocumentError,
} from "@/lib/dashboards";
import { displayTimestamp } from "@/lib/display-time";
import { useDisplayPreferences } from "../display-preferences";

const ORIGIN_LABEL: Record<RevisionInfo["origin"], string> = {
  dashboard: "Dashboard",
  mcp: "MCP",
  api: "API",
};

/** The API's message plus the first hint it attached, so a refused restore says what to do next. */
function restoreFailure(error: unknown): string {
  if (!(error instanceof Error)) return "Could not restore this revision.";
  const issues = (error as Partial<DocumentError>).issues as Issue[] | undefined;
  const hint =
    issues?.find((issue) => issue.hint)?.hint ??
    (error instanceof ApiError && typeof error.payload?.hint === "string"
      ? error.payload.hint
      : undefined);
  return hint ? `${error.message} ${hint}` : error.message;
}

/**
 * A dashboard's saved revisions, newest first. Restoring one saves it as a new revision, so
 * nothing is lost, and asks first because it replaces what the page shows.
 */
export function RevisionsSheet({
  productId,
  dashboard,
  open,
  onOpenChange,
  onRestored,
  finalFocus,
}: {
  productId: string;
  dashboard: { slug: string; revision: number };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRestored: () => Promise<void> | void;
  finalFocus?: React.RefObject<HTMLElement | null>;
}) {
  const { timeZone } = useDisplayPreferences();
  const [target, setTarget] = useState<number | null>(null);
  // The confirmation keeps naming its revision while it animates closed.
  const [shown, setShown] = useState<number | null>(null);
  if (target !== null && target !== shown) setShown(target);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const revisions = useQuery({
    queryKey: ["dashboard-revisions", productId, dashboard.slug, dashboard.revision],
    enabled: open,
    queryFn: ({ signal }) => listRevisions(productId, dashboard.slug, signal),
    staleTime: 0,
    retry: false,
  });

  async function restore() {
    if (target === null) return;
    setBusy(true);
    setError("");
    try {
      await restoreRevision(productId, dashboard.slug, target);
      setTarget(null);
      await onRestored();
    } catch (e) {
      setTarget(null);
      setError(restoreFailure(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (!next) setError("");
        onOpenChange(next);
      }}
    >
      <SheetContent finalFocus={finalFocus} className="sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Revisions</SheetTitle>
          <SheetDescription>
            Every save keeps the previous version. Restoring one saves it as a new revision.
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4">
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {revisions.isPending ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading revisions
            </p>
          ) : revisions.isError ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>
                {revisions.error instanceof Error
                  ? revisions.error.message
                  : "Could not load revisions."}
              </AlertDescription>
            </Alert>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {revisions.data.map((item) => {
                const current = item.revision === dashboard.revision;
                return (
                  <li key={item.revision} className="flex items-center gap-3 py-2.5">
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="flex items-center gap-2 text-sm font-medium">
                        Revision {item.revision}
                        <Badge variant="outline">{ORIGIN_LABEL[item.origin]}</Badge>
                        {current && <Badge variant="secondary">Current</Badge>}
                      </span>
                      <time
                        dateTime={item.created_at}
                        className="text-xs text-muted-foreground tabular-nums"
                      >
                        {displayTimestamp(Date.parse(item.created_at), timeZone).slice(0, -4)}
                      </time>
                    </div>
                    {!current && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        aria-label={`Restore revision ${item.revision}`}
                        onClick={() => setTarget(item.revision)}
                      >
                        Restore
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <AlertDialog
          open={target !== null}
          onOpenChange={(next) => !busy && !next && setTarget(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Restore revision {target ?? shown}?</AlertDialogTitle>
              <AlertDialogDescription>
                The dashboard returns to that version and is saved as a new revision. The current
                version stays in the list.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
              <AlertDialogAction disabled={busy} onClick={() => void restore()}>
                {busy && <Spinner data-icon="inline-start" aria-hidden="true" />}
                Restore revision
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SheetContent>
    </Sheet>
  );
}
