import type { ReportDialogProps } from "./overview-actions";
import { useReportQuery } from "@/lib/use-query";
import { queryReadOnly } from "@/lib/api";
import type { insights } from "@/server/insights";
import { useWorkspace } from "./app-shell";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
const load = (id: string, body: Record<string, unknown>, signal: AbortSignal) =>
  queryReadOnly<Awaited<ReturnType<typeof insights>>>(`/products/${id}/insights`, body, signal);
export function ProjectInsights({ open, onOpenChange, finalFocus }: ReportDialogProps) {
  const { product, range, refreshKey } = useWorkspace();
  const q = useReportQuery(
    load,
    "daily-insights",
    open ? product?.id : undefined,
    range,
    refreshKey,
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent finalFocus={finalFocus} className="max-h-[85dvh] overflow-auto">
        <DialogHeader>
          <DialogTitle>Significant changes</DialogTitle>
          <DialogDescription>
            Nightly changes across all sources. Each compares a completed UTC period with the
            preceding period.
          </DialogDescription>
        </DialogHeader>
        {q.loading && <p>Loading insights…</p>}
        {q.error && <p role="alert">{q.error}</p>}
        {q.data?.length === 0 && <p>No significant changes in the selected period.</p>}
        {q.data?.map((t) => (
          <article
            className="grid gap-1 border-b pb-3"
            key={JSON.stringify([t.at, t.days, t.dimension, t.label])}
          >
            <small>
              {new Date(t.at).toISOString().slice(0, 10)} · {t.days}d · {t.severity}
            </small>
            <strong>{t.title}</strong>
            <p>{t.description}</p>
          </article>
        ))}
      </DialogContent>
    </Dialog>
  );
}
