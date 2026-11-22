import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { analysis, analysisSpec } from "@/server/queries/analysis";
import { api, number, queryReadOnly } from "@/lib/api";
import { useReportQuery } from "@/lib/use-query";
import { useWorkspaceTarget } from "@/lib/workspace-route";
import { useWorkspace } from "./app-shell";
import { useOrganizationRole } from "./settings/settings-nav";
import { Input } from "./ui/input";
import { ValueSelect } from "./value-select";
import { Button } from "./ui/button";
import { ReportPanel } from "./report-panel";
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from "./ui/table";
import { ErrorState } from "./shared";
import { PageLoading } from "./loading";
import { WorldMap } from "./world-map";
import { TimelineMarkers } from "./chart-references";
type Spec = ReturnType<typeof analysisSpec>;
type Result = Awaited<ReturnType<typeof analysis>>;
const load = (id: string, body: Record<string, unknown>, signal: AbortSignal) =>
  queryReadOnly<Result>(`/products/${id}/analysis`, body, signal);
const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const pct = (v: number | null) => (v === null ? "—" : `${number(v * 100, 1)}%`);
function Curve({
  values,
  previous,
  average,
  label,
}: {
  values: (number | null)[];
  previous?: (number | null)[];
  average?: number | null;
  label: string;
}) {
  const line = (rows: (number | null)[]) =>
    rows
      .map((v, i) =>
        v === null
          ? ""
          : `${!i || rows[i - 1] == null ? "M" : "L"}${4 + (i / Math.max(1, rows.length - 1)) * 472} ${86 - v * 80}`,
      )
      .join(" ");
  return (
    <svg role="img" aria-label={label} viewBox="0 0 480 90" className="w-full max-h-36">
      <path d="M4 86h472" stroke="var(--border)" />
      {previous && (
        <path d={line(previous)} fill="none" stroke="var(--muted-foreground)" opacity=".55" />
      )}
      {average != null && (
        <path
          d={`M4 ${86 - average * 80}h472`}
          stroke="var(--data-tertiary)"
          strokeDasharray="4 3"
        />
      )}
      <path d={line(values)} fill="none" stroke="var(--data)" strokeWidth="2" />
      {values.map(
        (v, i) =>
          v !== null && (
            <circle
              key={i}
              cx={4 + (i / Math.max(1, values.length - 1)) * 472}
              cy={86 - v * 80}
              r="2"
              fill="var(--data)"
            >
              <title>{pct(v)}</title>
            </circle>
          ),
      )}
    </svg>
  );
}
export function AdvancedAnalysis({
  names,
  filters,
}: {
  names: string[];
  filters: Spec["filters"];
}) {
  const [open, setOpen] = useState(false);
  return (
    <ReportPanel
      open={open}
      onOpenChange={setOpen}
      wide
      label="Analyze"
      title="Explore analysis"
      description="Compare steps, cohorts and conversion rates over the selected period."
    >
      {open && <AnalysisForm names={names} filters={filters} />}
    </ReportPanel>
  );
}
function AnalysisForm({ names, filters }: { names: string[]; filters: Spec["filters"] }) {
  const { product, sourceId, range, refreshKey, refresh } = useWorkspace(),
    role = useOrganizationRole(),
    client = useQueryClient(),
    target = useWorkspaceTarget();
  const seed: Spec = {
    mode: "funnel",
    steps: [names[0] ?? "", names[1] ?? ""],
    returns: [names[1] ?? ""],
    period: "day",
    periods: 8,
    after: false,
    by: "actor",
    group_type: "",
    breakdown: "",
    at_step: 1,
    window_hours: 168,
    filters,
  };
  const [draft, setDraft] = useState(seed),
    [applied, setApplied] = useState<Spec>(),
    [name, setName] = useState(""),
    [id, setId] = useState(""),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false),
    [counts, setCounts] = useState(false),
    [step, setStep] = useState(0),
    [drop, setDrop] = useState(false),
    [page, setPage] = useState(1);
  const saved = useQuery({
    queryKey: ["analysis-views", product?.id],
    enabled: !!product,
    queryFn: ({ signal }) =>
      api<{ id: string; name: string; spec: Spec }[]>(
        `/products/${product?.id}/analysis-views`,
        "GET",
        undefined,
        signal,
      ),
  });
  const result = useReportQuery(
    load,
    "advanced-analysis",
    applied ? product?.id : undefined,
    { ...range, source_id: sourceId, spec: applied, page, step, drop },
    refreshKey,
  );
  const patch = (p: Partial<Spec>) => setDraft((d) => ({ ...d, ...p }));
  const run = (d: Spec) => {
    setApplied(d);
    setStep(0);
    setPage(1);
    setError("");
  };
  const write = async (remove = false) => {
    if (!applied || !name.trim() || pending) return;
    setPending(true);
    try {
      if (remove) {
        await api(`/products/${product!.id}/analysis-views/${id}`, "DELETE");
        setId("");
        setName("");
      } else {
        const v = await api<{ id: string }>(`/products/${product!.id}/analysis-views`, "POST", {
          name,
          id: id || undefined,
          spec: applied,
        });
        setId(v.id);
      }
      await client.invalidateQueries({ queryKey: ["analysis-views", product!.id] });
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };
  const r = result.data,
    split = (s: string) => s.split(",").map((v) => v.trim());
  return (
    <div className="grid min-w-0 gap-4">
      <ValueSelect
        label="Saved analyses"
        value={id || "*"}
        onValueChange={(v) => {
          const found = saved.data?.find((s) => s.id === v);
          setId(found?.id ?? "");
          setName(found?.name ?? "");
          setDraft(found?.spec ?? seed);
          if (found) run(found.spec);
          else setApplied(undefined);
        }}
        options={[["*", "New analysis"], ...(saved.data ?? []).map((v) => [v.id, v.name] as const)]}
      />
      <form
        className="grid min-w-0 gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          run({
            ...draft,
            returns: draft.mode === "retention" ? draft.returns.filter(Boolean) : [],
            steps: draft.steps.filter(Boolean),
          });
        }}
      >
        <ValueSelect
          label="Analysis type"
          value={draft.mode}
          onValueChange={(v) => patch({ mode: v, at_step: 1 })}
          options={[
            ["funnel", "Funnel"],
            ["retention", "Retention"],
            ["conversion", "Conversion over time"],
            ["breakdown", "Breakdown"],
          ]}
        />
        <datalist id="analysis-events">
          {names.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        <label>
          {draft.mode === "retention"
            ? "Start events"
            : draft.mode === "breakdown"
              ? "Event (optional)"
              : "Ordered events"}
          <Input
            list="analysis-events"
            value={draft.steps.join(",")}
            required={draft.mode !== "breakdown"}
            placeholder="signup,checkout"
            onChange={(e) => patch({ steps: split(e.target.value) })}
          />
        </label>
        {draft.mode === "retention" ? (
          <>
            <label>
              Return events
              <Input
                required
                list="analysis-events"
                value={draft.returns.join(",")}
                onChange={(e) => patch({ returns: split(e.target.value) })}
              />
            </label>
            <ValueSelect
              label="Return condition"
              value={draft.after ? "after" : "on"}
              onValueChange={(v) => patch({ after: v === "after" })}
              options={[
                ["on", "On period"],
                ["after", "On or after period"],
              ]}
            />
            <label>
              Periods
              <Input
                type="number"
                min={1}
                max={12}
                value={draft.periods}
                onChange={(e) => patch({ periods: e.target.valueAsNumber })}
              />
            </label>
          </>
        ) : (
          <>
            <label>
              Breakdown property
              <Input
                placeholder="e.g. plan"
                maxLength={64}
                value={draft.breakdown}
                onChange={(e) => patch({ breakdown: e.target.value })}
              />
            </label>
            {draft.mode !== "breakdown" && (
              <ValueSelect
                label="Count per"
                value={draft.by}
                onValueChange={(v) => patch({ by: v })}
                options={[
                  ["actor", "Actor"],
                  ["session", "Session"],
                  ["group", "Group"],
                ]}
              />
            )}
            {draft.by === "group" && (
              <label>
                Group type
                <Input
                  required
                  value={draft.group_type}
                  onChange={(e) => patch({ group_type: e.target.value })}
                />
              </label>
            )}
            {draft.mode === "funnel" && (
              <>
                <label>
                  Breakdown at step
                  <Input
                    type="number"
                    min={1}
                    max={draft.steps.length}
                    value={draft.at_step}
                    onChange={(e) => patch({ at_step: e.target.valueAsNumber })}
                  />
                </label>
                <label>
                  Window (hours)
                  <Input
                    type="number"
                    min={1}
                    max={8760}
                    value={draft.window_hours}
                    onChange={(e) => patch({ window_hours: e.target.valueAsNumber })}
                  />
                </label>
              </>
            )}
          </>
        )}
        {(draft.mode === "conversion" || draft.mode === "retention") && (
          <ValueSelect
            label="Period"
            value={draft.period}
            onValueChange={(v) => patch({ period: v as Spec["period"] })}
            options={[
              ["day", "Day"],
              ["week", "Week"],
              ["month", "Month"],
            ]}
          />
        )}
        <Button type="submit">Run analysis</Button>
      </form>
      {saved.error && <p role="alert">{saved.error.message}</p>}
      {result.error && <ErrorState message={result.error} retry={refresh} />}
      {applied && result.loading && <PageLoading label="Running analysis" />}
      {r?.mode === "funnel" && (
        <>
          <Table aria-label="Funnel steps">
            <TableHeader>
              <TableRow>
                {["Step", "Reached", "Previous", "Drop-off"].map((s) => (
                  <TableHead key={s}>{s}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.levels.map((n, i) => (
                <TableRow key={i}>
                  <TableCell>
                    {i + 1}. {applied?.steps[i]}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="link"
                      onClick={() => {
                        setStep(i + 1);
                        setDrop(false);
                        setPage(1);
                      }}
                    >
                      {n}
                    </Button>
                  </TableCell>
                  <TableCell>{r.prior[i] ?? 0}</TableCell>
                  <TableCell>
                    {i + 1 < r.levels.length && (
                      <Button
                        variant="link"
                        onClick={() => {
                          setStep(i + 1);
                          setDrop(true);
                          setPage(1);
                        }}
                      >
                        {n - r.levels[i + 1]}
                        {r.drop === i && n > r.levels[i + 1] ? " · largest drop" : ""}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p>
            Time to convert:{" "}
            {r.mean == null
              ? "No completions"
              : `mean ${number(r.mean / 1000, 2)} s · ` +
                r.quantiles
                  .map((v, i) => `p${[25, 50, 75, 90, 95, 99][i]} ${number(v / 1000, 2)} s`)
                  .join(" · ")}
          </p>
          {applied?.breakdown && (
            <ul>
              {r.groups.map((g) => (
                <li key={JSON.stringify(g.label)}>
                  {String(g.label ?? "Unassigned")}: {g.levels.join(" → ")}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {r?.mode === "funnel_people" && (
        <>
          <h3>
            {drop ? "Dropped after" : "Reached"} step {step}
          </h3>
          <ul>
            {r.rows.map((v) => (
              <li key={v.identity}>
                {v.profile ? (
                  <Link
                    {...target("/people", product?.slug)}
                    search={{ ...range, person: v.profile }}
                  >
                    {v.profile}
                  </Link>
                ) : (
                  v.identity
                )}
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button variant="outline" disabled={page === 1} onClick={() => setPage(page - 1)}>
              Previous
            </Button>
            <Button variant="outline" disabled={!r.more} onClick={() => setPage(page + 1)}>
              Next
            </Button>
            <Button
              onClick={() => {
                setPage(1);
                setStep(0);
              }}
            >
              Back to funnel
            </Button>
          </div>
        </>
      )}
      {r?.mode === "retention" && (
        <>
          <Button variant="outline" aria-pressed={counts} onClick={() => setCounts(!counts)}>
            {counts ? "Show percentages" : "Show counts"}
          </Button>
          <Curve label="Weighted retention by period" values={r.curve.map((v) => v.rate)} />
          <Table aria-label="Retention cohorts">
            <TableHeader>
              <TableRow>
                <TableHead>Cohort</TableHead>
                <TableHead>Size</TableHead>
                {r.curve.map((_, i) => (
                  <TableHead key={i}>P{i}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.rows.map((row) => (
                <TableRow key={row.at}>
                  <TableCell>{date(row.at)}</TableCell>
                  <TableCell>{row.size}</TableCell>
                  {row.counts.map((n, i) => (
                    <TableCell key={i}>
                      {n === null ? "—" : counts ? n : pct(n / row.size)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
              <TableRow>
                <TableCell>Weighted</TableCell>
                <TableCell>—</TableCell>
                {r.curve.map((v, i) => (
                  <TableCell key={i}>{counts ? (v.size ? v.n : "—") : pct(v.rate)}</TableCell>
                ))}
              </TableRow>
            </TableBody>
          </Table>
          <details>
            <summary>Active users by {applied?.period} and last seen</summary>
            {r.activity.map((v) => (
              <p key={v.at}>
                {date(v.at)} · {v.n} active
              </p>
            ))}
            {r.lastSeen.map((v) => (
              <p key={v.age}>
                {["Under 7", "7–13", "14–29", "30–59", "60+"][v.age]} days · {v.n} actors
              </p>
            ))}
          </details>
        </>
      )}
      {r?.mode === "conversion" && (
        <>
          {!r.lines.length && <p>No qualifying starts.</p>}
          {r.lines.map((l) => (
            <section key={JSON.stringify(l.label)}>
              <h3>
                {String(l.label ?? "All qualifying actors")} · {pct(l.average)}
              </h3>
              <div className="relative">
                <Curve
                  label="Conversion, previous period and weighted average"
                  values={l.points.map((v) => v.rate)}
                  previous={l.points.map((v) => v.previous)}
                  average={l.average}
                />
                <TimelineMarkers from={range.from} to={range.to} />
              </div>
              <p>
                Best: {l.best == null ? "—" : date(l.best)} · Worst:{" "}
                {l.worst == null ? "—" : date(l.worst)}
              </p>
              <details>
                <summary>Period values</summary>
                {l.points.map((p) => (
                  <p key={p.at}>
                    {date(p.at)} · {p.n}/{p.d} · {pct(p.rate)} · previous {pct(p.previous)}
                  </p>
                ))}
              </details>
            </section>
          ))}
        </>
      )}
      {r?.mode === "breakdown" && (
        <>
          {applied?.breakdown === "context.country" && (
            <WorldMap
              rows={r.report.rows
                .filter((v) => typeof v.label === "string")
                .map((v) => ({ label: String(v.label), count: v.volume }))}
              label="Events by country"
            />
          )}
          <Table aria-label="Analysis breakdown">
            <TableHeader>
              <TableRow>
                {["Value", "Events", "Share", "Previous"].map((v) => (
                  <TableHead key={v}>{v}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.report.rows.map((v) => (
                <TableRow key={JSON.stringify(v.label)}>
                  <TableCell>{String(v.label ?? "Unassigned")}</TableCell>
                  <TableCell>{v.volume}</TableCell>
                  <TableCell>{pct(v.share)}</TableCell>
                  <TableCell>{v.prior}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex gap-2">
            <Button disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </Button>
            <Button disabled={page * 25 >= r.report.total} onClick={() => setPage(page + 1)}>
              Next
            </Button>
          </div>
        </>
      )}
      {r && role !== "viewer" && (
        <form
          className="flex flex-wrap items-end gap-2 border-t pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            void write();
          }}
        >
          <label>
            Analysis view name
            <Input value={name} required maxLength={80} onChange={(e) => setName(e.target.value)} />
          </label>
          <Button type="submit" disabled={pending}>
            Save analysis view
          </Button>
          {id && (
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => void write(true)}
            >
              Delete view
            </Button>
          )}
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
