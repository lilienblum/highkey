import { useState } from "react";
import { ReportPanel } from "./report-panel";
import { useReportQuery } from "@/lib/use-query";
import { queryReadOnly } from "@/lib/api";
import type { insights } from "@/server/insights";
import { useWorkspace } from "./app-shell";
const load = (id: string, body: Record<string, unknown>, signal: AbortSignal) =>
  queryReadOnly<Awaited<ReturnType<typeof insights>>>(`/products/${id}/insights`, body, signal);
export function ProjectInsights() {
  const [open, setOpen] = useState(false);
  const { product, range, refreshKey } = useWorkspace();
  const q = useReportQuery(
    load,
    "daily-insights",
    open ? product?.id : undefined,
    range,
    refreshKey,
  );
  return (
    <ReportPanel
      open={open}
      onOpenChange={setOpen}
      title="Significant changes"
      description="Nightly changes across all sources. Each compares a completed UTC period with the preceding period."
    >
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
    </ReportPanel>
  );
}
