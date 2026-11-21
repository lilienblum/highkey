import { useNavigate, useSearch } from "@tanstack/react-router";
import { NoProduct, PageHeader, useAnalyticsPending, useWorkspace } from "./app-shell";
import { ErrorState } from "./shared";
import { PageLoading } from "./loading";
import { Button } from "./ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { ValueSelect } from "./value-select";
import { CohortPicker } from "./cohorts";
import { number, queryReadOnly } from "@/lib/api";
import { useReportQuery } from "@/lib/use-query";
import type { revenueReport } from "@/server/queries/revenue";

const groups = [
  ["source", "Source"],
  ["page", "Page"],
  ["profile", "Profile"],
  ["session", "Session"],
] as const;
const size = 25;
const load = (id: string, body: Record<string, unknown>, signal: AbortSignal) =>
  queryReadOnly<Awaited<ReturnType<typeof revenueReport>>>(
    `/products/${id}/revenue/query`,
    body,
    signal,
  );
const cents = (value: string) => BigInt(value).toLocaleString("en-US");

export function Revenue() {
  const { product, sourceId, range, refreshKey, refresh } = useWorkspace();
  const search = useSearch({ from: "/$orgSlug/$projectSlug/revenue" });
  const navigate = useNavigate({ from: "/$orgSlug/$projectSlug/revenue" });
  const group = search.group ?? "source",
    page = search.page ?? 1;
  const query = useReportQuery(
    load,
    "revenue",
    product?.id,
    {
      ...range,
      source_id: sourceId,
      group_by: group,
      cohort: search.cohort,
      page,
      page_size: size,
    },
    refreshKey,
    JSON.stringify([
      sourceId,
      search.period,
      search.days,
      search.snapshot,
      search.from,
      search.to,
      search.cohort,
      group,
      page,
    ]),
  );
  useAnalyticsPending(query.refreshing);
  if (!product) return <NoProduct />;
  const data = query.data;
  const setPage = (page: number) =>
    void navigate({
      search: (prev) => ({ ...prev, page: page === 1 ? undefined : page }),
      resetScroll: false,
    });
  const dimension = groups.find(([key]) => key === group)![1];
  return (
    <>
      <PageHeader
        title="Revenue"
        description="Net revenue from purchases and refunds in the selected period."
      />
      <section className="grid gap-4" aria-label="Revenue report">
        <CohortPicker
          project={product.id}
          value={search.cohort}
          change={(cohort) =>
            void navigate({
              search: (s) => ({ ...s, cohort, page: undefined }),
              resetScroll: false,
            })
          }
        />
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="text-muted-foreground text-xs">Net revenue · cents</div>
            <strong className="widget-value break-all">{data ? cents(data.cents) : "—"}</strong>
            {data && (
              <div className="text-muted-foreground text-xs">
                {number(data.revenue_events)} revenue events
              </div>
            )}
          </div>
          <label className="grid gap-1 text-xs text-muted-foreground">
            Group by
            <ValueSelect
              label="Group revenue by"
              value={group}
              options={groups}
              onValueChange={(next) =>
                void navigate({
                  search: (prev) => ({
                    ...prev,
                    group: next === "source" ? undefined : next,
                    page: undefined,
                  }),
                  resetScroll: false,
                })
              }
            />
          </label>
        </div>
        {query.error && <ErrorState message={query.error} retry={refresh} />}
        {query.loading ? (
          <PageLoading label="Loading revenue" />
        ) : (
          data && (
            <>
              <Table aria-label={`Revenue by ${dimension.toLowerCase()}`}>
                <TableHeader>
                  <TableRow>
                    <TableHead>{dimension}</TableHead>
                    <TableHead className="text-right">Events</TableHead>
                    <TableHead className="text-right">Net cents</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.map((row) => (
                    <TableRow key={JSON.stringify(row.label)}>
                      <TableCell className="whitespace-normal break-all">
                        {row.label === null
                          ? "Unattributed"
                          : group === "source"
                            ? (product.sources.find((s) => s.id === row.label)?.name ?? row.label)
                            : row.label}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {number(row.revenue_events)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{cents(row.cents)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {!data.rows.length && (
                <p role="status">
                  {data.groups ? "No rows on this page." : "No revenue events in this range."}
                </p>
              )}
              {(page > 1 || data.groups > size) && (
                <nav aria-label="Revenue pages" className="flex items-center justify-end gap-2">
                  <Button variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                    Previous
                  </Button>
                  <span>Page {page}</span>
                  <Button
                    variant="outline"
                    disabled={page * size >= data.groups || page >= 10000}
                    onClick={() => setPage(page + 1)}
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
