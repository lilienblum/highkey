import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useWorkspace, useAnalyticsPending } from "./app-shell";
import { useWorkspaceTarget } from "@/lib/workspace-route";
import { number, queryReadOnly, sourceGroups, type Group } from "@/lib/api";
import { useQuery, useReportQuery } from "@/lib/use-query";
import { displayValue } from "@/lib/display-values";
import { sourceParam } from "@/lib/workspace-search";
import { automaticBucket } from "@/lib/time-buckets";
import type { breakdownReport } from "@/server/queries/breakdowns";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogHeader,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "./ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "./ui/sheet";
import { Table, TableHeader, TableHead, TableRow, TableBody, TableCell } from "./ui/table";
import { ValueSelect } from "./value-select";
import { ErrorState, BreakdownRows } from "./shared";
import { AnalyticsChart } from "./analytics-chart";
import { PageLoading } from "./loading";

type Report = Awaited<ReturnType<typeof breakdownReport>>;
type Row = Report["rows"][number];
export const loadBreakdown = (id: string, body: Record<string, unknown>, signal: AbortSignal) =>
  queryReadOnly<Report>(`/products/${id}/breakdown`, body, signal);
function Spark({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  return (
    <svg width="78" height="24" role="img" aria-label={`Trend, oldest first: ${values.join(", ")}`}>
      <polyline
        points={values.map((v, i) => `${2 + (i * 74) / 13},${22 - (v / max) * 20}`).join(" ")}
        fill="none"
        stroke="var(--data)"
        strokeWidth="1.5"
      />
    </svg>
  );
}
export function BreakdownReport({
  dimension,
  title,
  filters,
}: {
  dimension: string;
  title: string;
  filters: Record<string, unknown>;
}) {
  const [open, setOpen] = useState(false),
    [row, setRow] = useState<Row>(),
    [page, setPage] = useState(1),
    [sort, setSort] = useState("volume"),
    [search, setSearch] = useState("");
  const { product, range, sourceId, refreshKey, refresh } = useWorkspace();
  const data = useReportQuery(
    loadBreakdown,
    "breakdown",
    open ? product?.id : undefined,
    { ...range, source_id: sourceId, ...filters, dimension, sort, page, search },
    refreshKey,
  );
  const isPage = dimension === "property:path";
  const label = (r: Row) =>
    dimension === "source_id"
      ? (product?.sources.find((s) => s.id === r.label)?.name ?? String(r.label))
      : displayValue(dimension, r.label);
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setRow(undefined);
      }}
    >
      <DialogTrigger render={<Button variant="link" size="sm" />}>Details</DialogTrigger>
      <DialogContent className="grid-cols-[minmax(0,1fr)] max-h-[90dvh] overflow-y-auto sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle>{title} report</DialogTitle>
          <DialogDescription>
            Share of the full selection and change from the preceding equal-length period. Trends
            show 14 equal intervals.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-2">
          <form
            className="flex flex-1 gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(String(new FormData(e.currentTarget).get("search") ?? ""));
              setPage(1);
            }}
          >
            <Input
              name="search"
              aria-label="Search report"
              placeholder="Search rows"
              maxLength={512}
              defaultValue={search}
            />
            <Button type="submit" variant="outline">
              Search
            </Button>
          </form>
          <ValueSelect
            label="Sort report"
            className="w-40"
            value={sort}
            onValueChange={(v) => {
              setSort(v);
              setPage(1);
            }}
            options={[
              ["volume", "Most activity"],
              ["label", "Label"],
              ["growth", "Highest growth"],
              ["trend", "Rising trend"],
              ["revenue", "Net revenue"],
            ]}
          />
        </div>
        {data.error && <ErrorState message={data.error} retry={refresh} />}
        {data.loading ? (
          <PageLoading label="Loading report" />
        ) : (
          data.data && (
            <>
              <Table aria-label={`${title} report`}>
                <TableHeader>
                  <TableRow>
                    {[
                      title,
                      isPage ? "Views" : "Events",
                      "Share",
                      "Change",
                      "Trend",
                      ...(isPage ? ["Entries", "Exits", "Bounce", "Time on page"] : []),
                      "Net cents",
                    ].map((k) => (
                      <TableHead key={k}>{k}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.data.rows.map((r) => (
                    <TableRow key={JSON.stringify(r.label)}>
                      <TableCell>
                        {r.label == null ? (
                          label(r)
                        ) : (
                          <Button
                            size="sm"
                            variant="link"
                            className="max-w-80 truncate"
                            onClick={() => setRow(r)}
                          >
                            {label(r)}
                          </Button>
                        )}
                      </TableCell>
                      <TableCell>{number(r.volume)}</TableCell>
                      <TableCell>{number(r.share * 100, 1)}%</TableCell>
                      <TableCell>
                        {r.change == null
                          ? "—"
                          : `${r.change > 0 ? "+" : ""}${number(r.change, 1)}%`}
                      </TableCell>
                      <TableCell>
                        <Spark values={r.trend} />
                      </TableCell>
                      {isPage && (
                        <>
                          <TableCell>{number(r.entries)}</TableCell>
                          <TableCell>{number(r.exits)}</TableCell>
                          <TableCell>
                            {r.bounce_rate == null ? "—" : `${number(r.bounce_rate, 1)}%`}
                          </TableCell>
                          <TableCell>
                            {r.time_ms == null ? "—" : `${number(r.time_ms / 1000, 1)} s`}
                          </TableCell>
                        </>
                      )}
                      <TableCell>{BigInt(r.cents).toLocaleString("en-US")}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {!data.data.rows.length && <p>No matching rows.</p>}
              <nav className="flex justify-end items-center gap-2" aria-label="Report pages">
                <Button
                  disabled={page === 1}
                  variant="outline"
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </Button>
                Page {page}
                <Button
                  disabled={page * 25 >= data.data.total || page >= 10000}
                  variant="outline"
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </nav>
            </>
          )
        )}
        {row && product && (
          <ReportRow
            key={JSON.stringify(row.label)}
            row={row}
            label={label(row)}
            dimension={dimension}
            filters={filters}
            close={() => setRow(undefined)}
            leave={() => {
              setRow(undefined);
              setOpen(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
function ReportRow({
  row,
  label,
  dimension,
  filters,
  close,
  leave,
}: {
  row: Row;
  label: string;
  dimension: string;
  filters: Record<string, unknown>;
  close: () => void;
  leave: () => void;
}) {
  const { product, sourceId, range, refresh, refreshKey } = useWorkspace(),
    target = useWorkspaceTarget(),
    nav = useNavigate();
  const [breakdown, setBreakdown] = useState("source_id"),
    bucket = automaticBucket(range);
  const property = dimension.startsWith("property:") ? dimension.slice(9) : undefined;
  const filter = property ? { property, op: "eq", value: row.label } : undefined;
  const ctx = {
    event: dimension === "name" ? row.label : filters.event,
    source: dimension === "source" ? row.label : filters.source,
    filters: [...((filters.filters as object[]) ?? []), ...(filter ? [filter] : [])],
  };
  const src = dimension === "source_id" ? String(row.label) : sourceId;
  const data = useQuery(
    product?.id,
    { ...range, source_id: src, ...ctx, bucket, group_by: breakdown, page_size: 1 },
    refreshKey,
  );
  useAnalyticsPending(data.refreshing);
  return (
    <Sheet
      open
      onOpenChange={(v) => {
        if (!v) close();
      }}
    >
      <SheetContent className="w-full overflow-y-auto p-4 sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="break-all">{label}</SheetTitle>
          <SheetDescription>Activity and breakdowns for this report row.</SheetDescription>
        </SheetHeader>
        {data.error && <ErrorState message={data.error} retry={refresh} />}
        {data.data && (
          <div className="h-48">
            <AnalyticsChart
              label="Events"
              bucket={bucket}
              series={data.data.series}
              range={range}
            />
          </div>
        )}
        <ValueSelect
          label="Row breakdown"
          options={[
            ["source_id", "Sources"],
            ["property:utm_campaign", "Campaigns"],
            ["property:version", "Versions"],
          ]}
          value={breakdown}
          onValueChange={setBreakdown}
        />
        {data.data && (
          <BreakdownRows
            title="Breakdown"
            groups={
              breakdown === "source_id"
                ? sourceGroups(data.data.groups, product?.sources)
                : data.data.groups
            }
            total={data.data.summary.total}
          />
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => {
              leave();
              void nav({
                ...target("/", product?.slug),
                search: {
                  ...range,
                  source: sourceParam(product?.sources, src),
                  ...(dimension === "source_id"
                    ? {}
                    : { filter: { field: dimension, value: row.label! } }),
                },
              });
            }}
          >
            Filter Overview
          </Button>
          <Link
            {...target("/events", product?.slug)}
            search={{
              ...range,
              source: sourceParam(product?.sources, src),
              drilldown: {
                ...range,
                sourceId: src,
                event: ctx.event as string | undefined,
                source: ctx.source as string | undefined,
                filter: filter as
                  { property: string; value: NonNullable<Group["label"]> } | undefined,
              },
            }}
            onClick={leave}
          >
            View events
          </Link>
        </div>
      </SheetContent>
    </Sheet>
  );
}
