import { displayMinute } from "@/lib/display-time";
import { filterOps, unaryFilter, textFilter } from "@/lib/filter-ops";
import { displayGroups } from "@/lib/display-values";
import { reportLink } from "@/lib/report-link";
import { automaticBucket } from "@/lib/time-buckets";
import { useWorkspaceTarget } from "@/lib/workspace-route";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearch, useNavigate } from "@tanstack/react-router";
import {
  appliedSpec,
  defaultSpec,
  type ExploreFilter,
  type ExploreSpec as Spec,
  type ExploreDrilldown,
  type SpecTextKey,
} from "@/lib/explore-search";
import {
  eventViewState,
  explorable,
  queryToSpec,
  specToQuery,
  type EventViewDocument,
} from "@/lib/views";
import { OpenSavedView, SaveEventViewButton, ViewActions, type SavedViewPage } from "./saved-views";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, FilterHorizontalIcon, PlayIcon } from "@hugeicons/core-free-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ValueSelect } from "./value-select";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { number, sourceGroups, type QueryResult } from "@/lib/api";
import { EventStream } from "./event-stream";
import { EventCatalog } from "./event-catalog";
import { PatternReports } from "./pattern-reports";
import { useEventCatalog } from "@/lib/use-event-catalog";
import { useQuery, useReportQuery } from "@/lib/use-query";
import { queryReadOnly } from "@/lib/api";
import { eventContext } from "@/lib/event-context";
import type { eventOptions } from "@/server/queries/event-options";
const loadOptions = (id: string, body: Record<string, unknown>, signal: AbortSignal) =>
  queryReadOnly<Awaited<ReturnType<typeof eventOptions>>>(
    `/products/${id}/event-options`,
    body,
    signal,
  );
import { useWorkspace, useAnalyticsPending, PageHeader, NoProduct } from "./app-shell";
import { Breakdown, ErrorState, NoEvents, PinChips, SeriesChart } from "./shared";
import { ExploreLoading } from "./loading";
import { Spinner } from "@/components/ui/spinner";
export function Explore() {
  const workspaceTarget = useWorkspaceTarget();
  const { product, sourceId } = useWorkspace();
  const { drilldown, invalidDrilldown, invalidQuery, view, viewAt } = useSearch({ strict: false });
  if (
    invalidQuery ||
    invalidDrilldown ||
    (drilldown && (!product || (drilldown.sourceId && !sourceId)))
  )
    return (
      <>
        <PageHeader
          title="This selection is unavailable"
          description={
            invalidDrilldown || invalidQuery
              ? "The link contains an invalid project, date range, or filter. Clear it to explore your projects."
              : "The project or source in this link is not available in this workspace."
          }
        />
        <Button
          variant="outline"
          nativeButton={false}
          role="link"
          render={<Link {...workspaceTarget("/events", product?.slug)} search={{}} />}
        >
          Clear selection
        </Button>
      </>
    );
  // A saved view opens by loading its query and version into the URL, so reloads and history
  // keep them.
  if (product && view && !viewAt && !drilldown)
    return (
      <OpenSavedView
        key={`${product.id}:${view}`}
        page={eventViews}
        product={product}
        slug={view}
        loading={<ExploreLoading />}
      />
    );
  return product ? (
    <ExploreProduct
      key={`${product.id}:${sourceId ?? "all"}:${JSON.stringify(drilldown)}`}
      drilldown={drilldown}
    />
  ) : (
    <NoProduct />
  );
}
const opSymbols: Record<string, string> = {
  eq: "=",
  ne: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
};
function filterText(filter: ExploreFilter) {
  return `${filter.property} ${opSymbols[filter.op] ?? filter.op} ${JSON.stringify(filter.value)}`;
}

/** Event views on the Events page: a view's query fills the builder and its chips. */
const eventViews: SavedViewPage<EventViewDocument> = {
  kind: "events",
  path: "/events",
  title: "Events",
  noun: "query",
  search: (stored) => {
    const spec = queryToSpec(stored.document.query);
    return explorable(spec) ? { query: spec, page: undefined } : undefined;
  },
  stateOf: (document) => eventViewState(queryToSpec(document.query)),
  clear: () => ({}),
};
function ExploreProduct({ drilldown }: { drilldown?: ExploreDrilldown }) {
  const workspaceTarget = useWorkspaceTarget();
  const { product, source, sourceId, range, refresh, refreshKey } = useWorkspace();
  const catalog = useEventCatalog(product?.id);
  const search = useSearch({ strict: false });
  const navigate = useNavigate({ from: "/$orgSlug/$projectSlug/events" });
  const applied: Spec = appliedSpec({ query: search.query, drilldown });
  const appliedKey = JSON.stringify(applied);
  const [draft, setDraft] = useState<Spec>(applied);
  // Choices made in the builder and not run yet are the reader's own, as much as a run query.
  const draftPending = JSON.stringify(draft) !== appliedKey;
  const [showFilter, setShowFilter] = useState(!!applied.filterProperty);
  const options = useReportQuery(
    loadOptions,
    "event-options",
    product?.id,
    {
      ...range,
      source_id: draft.sourceId ?? sourceId,
      event: draft.event.startsWith("@") ? "" : draft.event,
      property:
        showFilter && /^[A-Za-z0-9_./-]{1,64}$/.test(draft.filterProperty)
          ? draft.filterProperty
          : undefined,
    },
    refreshKey,
  );
  const properties = [
    ...new Set([
      ...(options.data?.keys ?? []),
      ...Object.keys(eventContext).map((k) => `context.${k}`),
    ]),
  ];
  useEffect(() => {
    const applied: Spec = JSON.parse(appliedKey);
    setDraft(applied);
    setShowFilter(!!applied.filterProperty);
  }, [appliedKey]);
  const setApplied = (next: Spec | ((value: Spec) => Spec)) => {
    const query = typeof next === "function" ? next(applied) : next;
    void navigate({ search: (previous) => ({ ...previous, query, page: 1 }), resetScroll: false });
  };
  const bucket = automaticBucket(range);
  // A rolling end time advances without changing the selected dates or URL.
  const rangeKey =
    drilldown || search.snapshot || search.from
      ? `${range.from}:${range.to}`
      : `${search.period ?? search.days ?? "default"}`;
  const pageSize = search.pageSize ?? 15;
  const page = (search.page ?? 1) - 1;
  const setPage = (page: number) =>
    void navigate({ search: (previous) => ({ ...previous, page: page + 1 }), resetScroll: false });
  // A view is open once the page has applied a version of it.
  const openView = search.viewAt
    ? product?.views?.find(
        (candidate) => candidate.kind === "events" && candidate.slug === search.view,
      )
    : undefined;
  const dropPin = (patch: Partial<Spec>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setApplied((d) => ({ ...d, ...patch }));
  };
  const [validation, setValidation] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const retry = () => setRetryKey((key) => key + 1);
  const filters = useMemo(() => {
    if (!applied.filterProperty) return [];
    if (unaryFilter(applied.filterOp))
      return [{ property: applied.filterProperty, op: applied.filterOp }];
    if (textFilter(applied.filterOp))
      return [
        { property: applied.filterProperty, op: applied.filterOp, value: applied.filterValue },
      ];
    let value: unknown = applied.filterValue;
    try {
      value = JSON.parse(applied.filterValue);
    } catch {}
    return [{ property: applied.filterProperty, op: applied.filterOp, value }];
  }, [applied]);
  const moreFilters = applied.moreFilters ?? [];
  const allFilters = useMemo(() => [...filters, ...moreFilters], [filters, moreFilters]);
  const scopeKey = JSON.stringify([product?.id, sourceId, rangeKey, applied, search.order]);
  const query = useQuery(
    product?.id,
    {
      ...range,
      bucket,
      order: search.order,
      source_id: applied.sourceId ?? sourceId,
      identity_kind: applied.identityKind,
      event: applied.event || undefined,
      source: applied.source || undefined,
      measure: applied.measure,
      property: applied.property,
      group_by: applied.group,
      filters: allFilters,
      page,
      page_size: pageSize,
    },
    `${refreshKey}:${retryKey}`,
    `${scopeKey}:${page}:${pageSize}`,
  );
  useAnalyticsPending(query.refreshing);
  const [lastResult, setLastResult] = useState<{ scope: string; data: QueryResult }>();
  useEffect(() => {
    if (query.data) setLastResult({ scope: scopeKey, data: query.data });
  }, [query.data, scopeKey]);
  const data = query.data ?? (lastResult?.scope === scopeKey ? lastResult.data : undefined);
  const update = (key: SpecTextKey, value: string) => setDraft((d) => ({ ...d, [key]: value }));
  const measureLabels: Record<string, string> = {
    count: "Event count",
    actors: "Distinct actors",
    sum: "Numeric sum",
    avg: "Numeric average",
    p50: "Duration p50",
    p95: "Duration p95",
    p99: "Duration p99",
    min: "Numeric minimum",
    max: "Numeric maximum",
  };
  return (
    <>
      <PageHeader
        title="Events"
        description={`${openView ? `Saved view ${openView.name}. ` : ""}Query and inspect activity from ${source ? `${product?.name} / ${source.name}` : product?.name}.`}
      >
        {product && openView && search.viewAt && (
          <ViewActions<EventViewDocument>
            key={openView.id}
            product={product}
            view={openView}
            page={eventViews}
            appliedAt={search.viewAt}
            state={draftPending ? `${eventViewState(applied)}+draft` : eventViewState(applied)}
            withCurrent={(stored) => ({ ...stored, query: specToQuery(applied) })}
            onDeleted={() =>
              navigate({
                search: (previous) => ({
                  ...previous,
                  view: undefined,
                  viewAt: undefined,
                  query: undefined,
                  page: undefined,
                }),
              })
            }
          />
        )}
        {product && !openView && <SaveEventViewButton product={product} spec={applied} />}
        {product && <EventCatalog id={product.id} observed={data?.event_names ?? []} />}
        {product && (
          <PatternReports
            filters={{
              source_id: applied.sourceId ?? sourceId,
              identity_kind: applied.identityKind,
              event: applied.event || undefined,
              source: applied.source || undefined,
              filters: allFilters,
            }}
          />
        )}
      </PageHeader>
      {drilldown && (
        <section className="drilldown-context" aria-label="Overview selection">
          <div>
            <strong>Overview selection</strong>
            <p className="drilldown-range">
              <time dateTime={range.from} title={range.from}>
                {displayMinute(Date.parse(range.from), "UTC")}
              </time>
              {" to "}
              <time dateTime={range.to} title={range.to}>
                {displayMinute(Date.parse(range.to), "UTC")}
              </time>
              {" UTC"}
            </p>
            <div className="drilldown-filters">
              {applied.event && <Badge variant="outline">Event · {applied.event}</Badge>}
              {applied.source && (
                <Badge variant="outline">
                  Client · {applied.source}
                  <button
                    type="button"
                    aria-label="Remove client filter"
                    onClick={() => {
                      setDraft((d) => ({ ...d, source: "" }));
                      setApplied((d) => ({ ...d, source: "" }));
                    }}
                  >
                    <HugeiconsIcon
                      icon={Cancel01Icon}
                      strokeWidth={2}
                      aria-hidden="true"
                      className="size-3"
                    />
                  </button>
                </Badge>
              )}
              {applied.filterProperty && (
                <Badge variant="outline" className="drilldown-property">
                  {applied.filterProperty} {applied.filterOp === "eq" ? "=" : applied.filterOp}{" "}
                  {applied.filterValue}
                </Badge>
              )}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            nativeButton={false}
            role="link"
            render={<Link {...workspaceTarget("/events", product?.slug)} search={{}} />}
          >
            <HugeiconsIcon
              icon={Cancel01Icon}
              strokeWidth={2}
              aria-hidden="true"
              data-icon="inline-start"
            />
            Clear selection
          </Button>
        </section>
      )}
      <Card className="query-builder">
        <CardContent>
          <form
            aria-label="Build a query"
            onSubmit={(e) => {
              e.preventDefault();
              setValidation("");
              if (draft.filterProperty && !unaryFilter(draft.filterOp) && !draft.filterValue) {
                setValidation("Enter a filter value. Use true, 42, or a string.");
                return;
              }
              setApplied({ ...draft });
              refresh();
            }}
          >
            <datalist id="observed-properties">
              {properties.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
            <datalist id="observed-values">
              {options.data?.values.map((v) => (
                <option key={v} value={textFilter(draft.filterOp) ? String(JSON.parse(v)) : v} />
              ))}
            </datalist>
            <Collapsible open={showFilter} onOpenChange={setShowFilter}>
              <FieldGroup className="query-controls">
                <Field>
                  <FieldLabel htmlFor="event">Event</FieldLabel>
                  <ValueSelect
                    id="event"
                    value={draft.event || "*"}
                    onValueChange={(value) => update("event", value === "*" ? "" : value)}
                    options={[
                      ["*", "All events"],
                      ...Array.from(
                        new Set([
                          ...(data?.event_names ?? []),
                          ...(options.data?.names ?? []),
                          ...(catalog.data ?? []).filter((d) => d.rules).map((d) => d.name),
                          ...(draft.event ? [draft.event] : []),
                        ]),
                      ).map((name): [string, string] => [name, name]),
                    ]}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="measure">Measure</FieldLabel>
                  <ValueSelect
                    id="measure"
                    value={draft.measure}
                    onValueChange={(value) => {
                      update("measure", value);
                      if (value.startsWith("p")) update("property", "duration_ms");
                    }}
                    options={Object.entries(measureLabels)}
                  />
                </Field>
                {!["count", "actors"].includes(draft.measure) && (
                  <Field>
                    <FieldLabel htmlFor="measure-property">Numeric property</FieldLabel>
                    <Input
                      id="measure-property"
                      list="observed-properties"
                      value={draft.property}
                      onChange={(e) => update("property", e.target.value)}
                      required
                    />
                  </Field>
                )}
                <Field>
                  <FieldLabel htmlFor="group">Group by</FieldLabel>
                  <ValueSelect
                    id="group"
                    value={draft.group}
                    onValueChange={(value) => update("group", value)}
                    options={[
                      ["name", "Event name"],
                      ["source_id", "Source"],
                      ["source", "Client"],
                      ["identity_kind", "Identity kind"],
                      ["property:path", "Page path"],
                      ["property:referrer", "Referrer"],
                      ["property:utm_source", "Campaign source"],
                      ["property:utm_campaign", "Campaign"],
                      ["property:command", "Command"],
                      ["property:os", "OS"],
                      ["property:version", "Version"],
                      ["property:arch", "Architecture"],
                      ["property:success", "Success"],
                      ...properties
                        .filter(
                          (k) =>
                            ![
                              "path",
                              "referrer",
                              "utm_source",
                              "utm_campaign",
                              "command",
                              "os",
                              "version",
                              "arch",
                              "success",
                            ].includes(k),
                        )
                        .map((k): [string, string] => [`property:${k}`, k]),
                    ]}
                  />
                </Field>
                <div className="query-actions">
                  <CollapsibleTrigger
                    render={<Button type="button" variant="outline" id="query-filter-toggle" />}
                  >
                    <HugeiconsIcon
                      icon={FilterHorizontalIcon}
                      strokeWidth={2}
                      aria-hidden="true"
                      data-icon="inline-start"
                    />
                    Filter
                    {applied.filterProperty || moreFilters.length
                      ? ` · ${(applied.filterProperty ? 1 : 0) + moreFilters.length}`
                      : ""}
                  </CollapsibleTrigger>
                  <Button
                    type="submit"
                    aria-label="Run query"
                    aria-busy={query.loading}
                    disabled={query.loading}
                  >
                    {query.loading ? (
                      <Spinner data-icon="inline-start" aria-hidden="true" />
                    ) : (
                      <HugeiconsIcon
                        icon={PlayIcon}
                        strokeWidth={2}
                        aria-hidden="true"
                        data-icon="inline-start"
                      />
                    )}
                    Run query
                  </Button>
                </div>
              </FieldGroup>
              <CollapsibleContent>
                <FieldGroup className="filter-controls">
                  <Field>
                    <FieldLabel htmlFor="filter-property">Property</FieldLabel>
                    <Input
                      id="filter-property"
                      list="observed-properties"
                      placeholder="e.g. success"
                      value={draft.filterProperty}
                      onChange={(e) => update("filterProperty", e.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="filter-op">Condition</FieldLabel>
                    <ValueSelect
                      id="filter-op"
                      value={draft.filterOp}
                      onValueChange={(value) => update("filterOp", value)}
                      options={filterOps}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="filter-value">Typed value</FieldLabel>
                    <Input
                      id="filter-value"
                      list="observed-values"
                      disabled={unaryFilter(draft.filterOp)}
                      placeholder={'true, 42, or "build"'}
                      value={draft.filterValue}
                      onChange={(e) => update("filterValue", e.target.value)}
                    />
                  </Field>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Remove filter"
                    onClick={() => {
                      setDraft((d) => ({ ...d, filterProperty: "", filterValue: "" }));
                      setApplied((d) => ({ ...d, filterProperty: "", filterValue: "" }));
                      setShowFilter(false);
                    }}
                  >
                    <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} aria-hidden="true" />
                  </Button>
                </FieldGroup>
              </CollapsibleContent>
            </Collapsible>
            <PinChips
              fallback={() => document.getElementById("query-filter-toggle")}
              pins={[
                ...(applied.sourceId
                  ? [
                      {
                        label: `Source · ${product?.sources.find((s) => s.id === applied.sourceId)?.name ?? "unavailable"}`,
                        remove: "Remove source",
                        onRemove: () => dropPin({ sourceId: undefined }),
                      },
                    ]
                  : []),
                ...(applied.identityKind
                  ? [
                      {
                        label: `Identity kind · ${applied.identityKind}`,
                        remove: "Remove identity kind",
                        onRemove: () => dropPin({ identityKind: undefined }),
                      },
                    ]
                  : []),
                ...moreFilters.map((filter, index) => ({
                  label: filterText(filter),
                  remove: `Remove filter ${filterText(filter)}`,
                  onRemove: () => {
                    const next = moreFilters.filter((_, i) => i !== index);
                    dropPin({ moreFilters: next.length ? next : undefined });
                  },
                })),
              ]}
            />
            {validation && (
              <p role="alert" className="form-error">
                {validation}
              </p>
            )}
          </form>
        </CardContent>
      </Card>
      {query.error && !data ? (
        <ErrorState message={query.error} retry={retry} />
      ) : !data ? (
        <ExploreLoading />
      ) : (
        data && (
          <>
            {query.error && query.data && <ErrorState message={query.error} retry={retry} />}
            <div className="explore-summary">
              <div className="explore-summary-value">
                <span>{measureLabels[applied.measure]}</span>
                <strong>
                  {number(data.summary.value, 2)}
                  {applied.property === "duration_ms" &&
                  !["count", "actors"].includes(applied.measure)
                    ? " ms"
                    : ""}
                </strong>
                <span>across {number(data.summary.total)} matching events</span>
              </div>
            </div>
            {data.summary.total === 0 ? (
              <NoEvents />
            ) : (
              <>
                <div className="explore-charts">
                  <SeriesChart
                    data={data}
                    title="Results over time"
                    bucket={bucket}
                    description={
                      ["count", "actors"].includes(applied.measure)
                        ? `One point per ${bucket} · UTC`
                        : `One point per ${bucket} · UTC · missing numeric values are excluded`
                    }
                    label={measureLabels[applied.measure]}
                  />
                  <Breakdown
                    title="Breakdown"
                    externalHref={(group) =>
                      reportLink(applied.group, group.label, product?.website_url)
                    }
                    description={`Grouped by ${applied.group.replace("property:", "")}`}
                    groups={
                      applied.group === "source_id"
                        ? sourceGroups(data.groups, product?.sources)
                        : displayGroups(data.groups, applied.group)
                    }
                    unit="Value"
                  />
                </div>
                <EventStream
                  key={`${scopeKey}:${page}:${pageSize}`}
                  events={query.data?.events ?? []}
                  total={data.summary.total}
                  page={page}
                  pageSize={pageSize}
                  loading={query.loading}
                  refreshing={query.refreshing}
                  error={query.data ? undefined : query.error}
                  onRetry={retry}
                  onPageChange={setPage}
                  oldest={search.order === "oldest"}
                  onOrderChange={() =>
                    void navigate({
                      search: (prev) => ({
                        ...prev,
                        page: undefined,
                        order: prev.order === "oldest" ? undefined : "oldest",
                      }),
                      resetScroll: false,
                    })
                  }
                  onFollow={(property, value) =>
                    void navigate({
                      search: (prev) => ({
                        ...prev,
                        query: {
                          ...defaultSpec,
                          filterProperty: property,
                          filterValue: JSON.stringify(value),
                        },
                        order: "oldest",
                        page: undefined,
                        view: undefined,
                        viewAt: undefined,
                      }),
                      resetScroll: false,
                    })
                  }
                  onPageSizeChange={(size) => {
                    void navigate({
                      search: (previous) => ({ ...previous, pageSize: size, page: 1 }),
                      resetScroll: false,
                    });
                  }}
                  onFilterProperty={(property, value) => {
                    const next = {
                      ...applied,
                      filterProperty: property,
                      filterOp: "eq",
                      filterValue: JSON.stringify(value),
                    };
                    setDraft(next);
                    setApplied(next);
                    setValidation("");
                    setShowFilter(true);
                    requestAnimationFrame(() => document.getElementById("filter-value")?.focus());
                  }}
                />
              </>
            )}
          </>
        )
      )}
    </>
  );
}
