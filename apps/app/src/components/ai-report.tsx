import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useWorkspace, NoProduct, PageHeader, useAnalyticsPending } from "./app-shell";
import { useWorkspaceTarget } from "@/lib/workspace-route";
import { number, queryReadOnly } from "@/lib/api";
import { useReportQuery } from "@/lib/use-query";
import type { generations } from "@/server/queries/generations";
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from "./ui/table";
import { Button } from "./ui/button";
import { ValueSelect } from "./value-select";
import { CohortPicker } from "./cohorts";
import { ErrorState } from "./shared";
import { PageLoading } from "./loading";

const load = (id: string, body: Record<string, unknown>, signal: AbortSignal) =>
  queryReadOnly<Awaited<ReturnType<typeof generations>>>(
    `/products/${id}/ai/generations`,
    body,
    signal,
  );
const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 8,
});
const money = (n: number | null) => (n !== null ? dollars.format(n) : "—");
const route = "/$orgSlug/$projectSlug/ai";
export function AIReport() {
  const { product, sourceId, range, refreshKey, refresh } = useWorkspace(),
    s = useSearch({ from: route }),
    navigate = useNavigate({ from: route }),
    target = useWorkspaceTarget();
  const group = s.aiGroup ?? "model",
    page = s.page ?? 1;
  const report = useReportQuery(
    load,
    "generations",
    product?.id,
    { ...range, source_id: sourceId, group_by: group, page, trace_id: s.trace, cohort: s.cohort },
    refreshKey,
    JSON.stringify([
      sourceId,
      group,
      page,
      s.trace,
      s.period,
      s.days,
      s.snapshot,
      s.from,
      s.to,
      s.cohort,
    ]),
  );
  useAnalyticsPending(report.refreshing);
  const update = (patch: Partial<typeof s>) =>
    void navigate({ search: (prev) => ({ ...prev, ...patch }), resetScroll: false });
  if (!product) return <NoProduct />;
  const d = report.data;
  return (
    <>
      <PageHeader
        title="AI costs"
        description="Reported generation costs, token usage and multi-step traces."
      />
      <section aria-label="AI cost report" className="grid gap-4 min-w-0">
        <CohortPicker
          project={product.id}
          value={s.cohort}
          change={(cohort) => update({ cohort, page: undefined })}
        />
        {s.trace && (
          <div className="flex flex-wrap items-center gap-2">
            <strong className="break-all">Trace: {s.trace}</strong>
            <Button variant="outline" onClick={() => update({ trace: undefined, page: undefined })}>
              All generations
            </Button>
          </div>
        )}
        {report.error && <ErrorState message={report.error} retry={refresh} />}
        {report.loading ? (
          <PageLoading label="Loading AI costs" />
        ) : (
          d && (
            <>
              <div>
                <span className="text-muted-foreground">Reported cost · USD</span>
                <p className="widget-value">{money(d.cost_usd)}</p>
                <p>
                  {number(d.priced)} of {number(d.calls)} calls reported a cost · {number(d.errors)}{" "}
                  errors
                </p>
              </div>
              <ValueSelect
                label="Group AI costs by"
                value={group}
                options={[
                  ["model", "Model"],
                  ["profile", "Profile"],
                  ["feature", "Feature"],
                ]}
                onValueChange={(v) =>
                  update({ aiGroup: v === "model" ? undefined : v, page: undefined })
                }
              />
              <Table aria-label="AI cost breakdown">
                <TableHeader>
                  <TableRow>
                    {[group, "Calls", "Priced calls", "Reported USD"].map((k) => (
                      <TableHead key={k}>{k}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.groups.map((row) => (
                    <TableRow key={JSON.stringify(row.label)}>
                      <TableCell>
                        {group === "profile" && row.label ? (
                          <Link
                            {...target("/people", product.slug)}
                            search={{ ...range, source: s.source, person: row.label }}
                          >
                            {row.label}
                          </Link>
                        ) : (
                          (row.label ?? "Unattributed")
                        )}
                      </TableCell>
                      <TableCell>{number(row.calls)}</TableCell>
                      <TableCell>{number(row.priced)}</TableCell>
                      <TableCell>{money(row.cost_usd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <h2>{s.trace ? "Trace timeline" : "Generations"}</h2>
              <Table aria-label="AI generations">
                <TableHeader>
                  <TableRow>
                    {[
                      "Time (UTC)",
                      "Model",
                      "Feature",
                      "Input / output tokens",
                      "Latency",
                      "USD",
                      "Status",
                      "Trace",
                    ].map((h) => (
                      <TableHead key={h}>{h}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        {new Date(row.time).toISOString().replace("T", " ").slice(0, 19)}
                      </TableCell>
                      <TableCell>
                        {[row.provider, row.model].filter(Boolean).join(" / ") || "—"}
                      </TableCell>
                      <TableCell>{row.feature ?? "—"}</TableCell>
                      <TableCell>
                        {number(row.input_tokens)} / {number(row.output_tokens)}
                      </TableCell>
                      <TableCell>
                        {row.latency_ms != null ? `${number(row.latency_ms, 1)} ms` : "—"}
                      </TableCell>
                      <TableCell>{money(row.cost_usd)}</TableCell>
                      <TableCell>
                        {row.error
                          ? "Error"
                          : row.cancelled
                            ? "Cancelled"
                            : row.error === false
                              ? "OK"
                              : "—"}
                      </TableCell>
                      <TableCell>
                        {!s.trace && row.trace_id ? (
                          <Link
                            from={route}
                            to={route}
                            search={(prev) => ({ ...prev, trace: row.trace_id!, page: undefined })}
                          >
                            {row.trace_id}
                          </Link>
                        ) : (
                          (row.trace_id ?? "—")
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {!d.calls && <p>No generations in this range.</p>}
              {(page > 1 || d.calls > 25) && (
                <nav className="flex items-center justify-end gap-2" aria-label="Generation pages">
                  <Button
                    variant="outline"
                    disabled={page <= 1}
                    onClick={() => update({ page: page - 1 })}
                  >
                    Previous
                  </Button>{" "}
                  Page {page}
                  <Button
                    variant="outline"
                    disabled={page * 25 >= d.calls || page >= 10000}
                    onClick={() => update({ page: page + 1 })}
                  >
                    Next
                  </Button>
                </nav>
              )}
            </>
          )
        )}
      </section>
    </>
  );
}
