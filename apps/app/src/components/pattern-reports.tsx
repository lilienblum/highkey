import { useState } from "react";
import { ReportPanel } from "./report-panel";
import type { patterns } from "@/server/queries/patterns";
import { queryReadOnly, number } from "@/lib/api";
import { useReportQuery } from "@/lib/use-query";
import { useWorkspace } from "./app-shell";
import { ErrorState } from "./shared";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { ValueSelect } from "./value-select";
import { PageLoading } from "./loading";

type Result = Awaited<ReturnType<typeof patterns>>;
type Metric = "visitors" | "sessions" | "bounce_rate" | "duration_ms";
const load = (id: string, body: Record<string, unknown>, signal: AbortSignal) =>
  queryReadOnly<Result>(`/products/${id}/patterns`, body, signal);
const reports = [
  ["weekly", "Weekly pattern"],
  ["flow", "Page flow"],
  ["distribution", "Distribution"],
] as const;
const metrics = [
  ["visitors", "Visitors"],
  ["sessions", "Sessions"],
  ["bounce_rate", "Bounce rate"],
  ["duration_ms", "Mean visit duration"],
] as const;
const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
function Heatmap({ data, metric }: { data: Extract<Result, { mode: "weekly" }>; metric: Metric }) {
  const peak = Math.max(0, ...data.cells.map((r) => r[metric] ?? 0));
  const unit = metric === "bounce_rate" ? "%" : metric === "duration_ms" ? "s" : "";
  const label = (v: number | null) =>
    v == null ? "—" : `${number(metric === "duration_ms" ? v / 1000 : v, unit ? 1 : 0)}${unit}`;
  return (
    <div className="overflow-x-auto">
      <table className="pattern-grid">
        <caption>{metrics.find(([k]) => k === metric)?.[1]} by weekday and hour (UTC)</caption>
        <thead>
          <tr>
            <th scope="col">UTC</th>
            {Array.from({ length: 24 }, (_, h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weekdays.map((day, d) => (
            <tr key={day}>
              <th scope="row">{day}</th>
              {data.cells.slice(d * 24, d * 24 + 24).map((c) => {
                const v = c[metric],
                  intensity = peak && v ? 1 + Math.ceil((3 * v) / peak) : 0;
                return (
                  <td
                    key={c.hour}
                    data-level={intensity}
                    title={`${day} ${c.hour}:00 UTC · ${label(v)}`}
                  >
                    <span className="sr-only">{label(v)}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-muted-foreground">
        Darker to brighter: 0 to {label(peak)}. Visitor counts use recorded visitor IDs. Session
        measures use the visit’s start hour.
      </p>
    </div>
  );
}
type Flow = Extract<Result, { mode: "flow" }>;
function FlowDiagram({ data }: { data: Flow }) {
  if (!data.paths.length) return <p>No visits match this path and step limit.</p>;
  const steps = Math.max(...data.paths.map((p) => p.pages.length));
  const levels = Array.from({ length: steps }, (_, i) => {
    const counts = new Map<string, number>();
    for (const r of data.paths) {
      const p = r.pages[i];
      if (p) counts.set(p, (counts.get(p) ?? 0) + r.sessions);
    }
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  });
  const links = new Map<string, { i: number; from: string; to: string; n: number }>();
  for (const r of data.paths)
    for (let i = 1; i < r.pages.length; i++) {
      const from = r.pages[i - 1],
        to = r.pages[i],
        k = JSON.stringify([i, from, to]);
      links.set(k, { i, from, to, n: (links.get(k)?.n ?? 0) + r.sessions });
    }
  const width = steps * 190,
    height = 46 + Math.max(...levels.map((l) => l.length)) * 34;
  const y = (i: number, page: string) => 48 + levels[i].findIndex(([p]) => p === page) * 34;
  return (
    <>
      <div className="overflow-x-auto">
        <svg
          role="img"
          aria-label={`Pages visited over ${steps} steps. Counts are listed below.`}
          width={width}
          height={height}
          className="max-w-none"
        >
          {Array.from(links.entries(), ([key, { i, from, to, n }]) => (
            <path
              key={key}
              d={`M ${(i - 1) * 190 + 136} ${y(i - 1, from)} C ${i * 190 - 28} ${y(i - 1, from)},${i * 190 - 20} ${y(i, to)},${i * 190} ${y(i, to)}`}
              fill="none"
              stroke="var(--data-tertiary)"
              opacity=".7"
              strokeWidth={1 + (8 * n) / data.total}
            />
          ))}
          {levels.map((l, i) => (
            <g key={i} transform={`translate(${i * 190},0)`}>
              <text x={0} y={17} fill="var(--muted-foreground)">
                Step {i + 1}
              </text>
              {l.map(([p, n]) => (
                <g key={p}>
                  <title>
                    {p}: {number(n)} visits
                  </title>
                  <rect
                    x={0}
                    y={y(i, p) - 12}
                    width={136}
                    height={24}
                    rx={4}
                    fill="var(--surface-inset)"
                  />
                  <text x={4} y={y(i, p) + 4} fontSize={12} fill="var(--foreground)">
                    {p.length > 17 ? p.slice(0, 16) + "…" : p}
                  </text>
                </g>
              ))}
            </g>
          ))}
        </svg>
      </div>
      <details>
        <summary>Paths and session counts</summary>
        <ol>
          {data.paths.map((r) => (
            <li key={JSON.stringify(r.pages)} className="break-all">
              {r.pages.join(" → ")} · {number(r.sessions)}
            </li>
          ))}
        </ol>
      </details>
      <p className="text-muted-foreground">
        Top {data.paths.length} {data.paths.length === 1 ? "path" : "paths"} from{" "}
        {number(data.total)} matching {data.total === 1 ? "visit" : "visits"}.
      </p>
    </>
  );
}
export function PatternReports({ filters }: { filters: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const { product, sourceId, range, refreshKey, refresh } = useWorkspace();
  const [mode, setMode] = useState("weekly"),
    [metric, setMetric] = useState<Metric>("visitors");
  const [flow, setFlow] = useState({ steps: 5, start_path: "", end_path: "" });
  const query = useReportQuery(
    load,
    "patterns",
    open ? product?.id : undefined,
    { ...range, source_id: sourceId, ...filters, mode, ...(mode === "flow" ? flow : {}) },
    refreshKey,
  );
  const data = query.data;
  return (
    <ReportPanel
      open={open}
      onOpenChange={setOpen}
      wide
      title="Activity patterns"
      description="Uses the current project, source, dates and event filters."
    >
      <Tabs value={mode} onValueChange={(v) => setMode(String(v))}>
        <TabsList variant="line" aria-label="Analysis reports" className="max-w-full">
          {reports.map(([k, label]) => (
            <TabsTrigger key={k} value={k}>
              <span className="sm:hidden">{k === "weekly" ? "Weekly" : label}</span>
              <span className="hidden sm:inline">{label}</span>
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={mode} className="grid min-w-0 gap-3">
          {mode === "weekly" && (
            <ValueSelect
              label="Weekly measure"
              value={metric}
              options={metrics}
              onValueChange={(v) => setMetric(v as Metric)}
            />
          )}
          {mode === "flow" && (
            <form
              className="flex flex-wrap gap-2 items-end"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                setFlow({
                  steps: Number(f.get("steps")),
                  start_path: String(f.get("from") || ""),
                  end_path: String(f.get("to") || ""),
                });
              }}
            >
              <label>
                From page
                <Input
                  name="from"
                  placeholder="Any entry"
                  defaultValue={flow.start_path}
                  maxLength={2048}
                />
              </label>
              <label>
                To page
                <Input
                  name="to"
                  placeholder="Any exit"
                  defaultValue={flow.end_path}
                  maxLength={2048}
                />
              </label>
              <label>
                Steps
                <Input
                  name="steps"
                  type="number"
                  required
                  min={2}
                  max={10}
                  defaultValue={flow.steps}
                />
              </label>
              <Button type="submit">Apply path</Button>
            </form>
          )}
          {query.error && <ErrorState message={query.error} retry={refresh} />}
          {query.loading ? (
            <PageLoading label="Loading report" />
          ) : data?.mode === "weekly" ? (
            <Heatmap data={data} metric={metric} />
          ) : data?.mode === "flow" ? (
            <FlowDiagram data={data} />
          ) : data?.mode === "distribution" ? (
            <>
              <p>Events per identified actor in this selection</p>
              <dl>
                {data.buckets.map((b) => (
                  <div className="grid grid-cols-[4rem_1fr_5rem] items-center gap-3" key={b.label}>
                    <dt>{b.label}</dt>
                    <div
                      aria-hidden="true"
                      style={{
                        width: `${(100 * b.actors) / Math.max(1, ...data.buckets.map((r) => r.actors))}%`,
                        height: 10,
                        background: "var(--data)",
                      }}
                    />
                    <dd>{number(b.actors)}</dd>
                  </div>
                ))}
              </dl>
            </>
          ) : null}
        </TabsContent>
      </Tabs>
    </ReportPanel>
  );
}
