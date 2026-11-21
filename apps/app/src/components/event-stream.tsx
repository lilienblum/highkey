import { useDisplayPreferences } from "./display-preferences";
import { displayTimestamp } from "@/lib/display-time";
import { useEffect, useMemo, useRef, useState } from "react";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  CommandLineIcon,
  Copy01Icon,
  CubeIcon,
  FilterHorizontalIcon,
  Globe02Icon,
  Tick01Icon,
} from "@hugeicons/core-free-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { number, type EventRow, type Properties } from "@/lib/api";
import { highlight, TypedValue } from "@/lib/highlight";
import { ErrorState } from "./shared";
import { ValueSelect } from "./value-select";
import { useWorkspace } from "./app-shell";
import { Link } from "@tanstack/react-router";
import { useWorkspaceTarget } from "@/lib/workspace-route";
import { defaultSpec } from "@/lib/explore-search";
import { useEventCatalog } from "@/lib/use-event-catalog";
import { eventSentence } from "@/lib/event-catalog";
import { eventContext } from "@/lib/event-context";
import { SourceIcon } from "./source-icon";
import { queryReadOnly } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";

type EventStreamProps = {
  events: EventRow[];
  total: number;
  page: number;
  pageSize: number;
  loading: boolean;
  refreshing?: boolean;
  error?: string;
  onRetry: () => void;
  onPageChange: (page: number) => void;
  oldest: boolean;
  onOrderChange: () => void;
  onFollow: (property: string, value: Properties[string]) => void;
  onPageSizeChange: (size: number) => void;
  onFilterProperty: (property: string, value: Properties[string]) => void;
};

function EventContext({ event }: { event: EventRow }) {
  const p = event.properties;
  const main =
    typeof p.path === "string" ? p.path : typeof p.command === "string" ? p.command : undefined;
  const extra =
    typeof p.path === "string"
      ? typeof p.referrer === "string"
        ? `From ${p.referrer || "empty referrer"}`
        : undefined
      : typeof p.command === "string" && typeof p.version === "string"
        ? `v${p.version}`
        : undefined;
  const fallback = Object.entries(p)
    .slice(0, 2)
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
    .join(" · ");
  return (
    <div className="stream-context">
      <code title={main ?? fallback}>
        {main === "" ? '""' : (main ?? (fallback || "No properties"))}
      </code>
      <div className="stream-context-details">
        {typeof p.success === "boolean" && (
          <Badge variant={p.success ? "secondary" : "destructive"}>
            <HugeiconsIcon
              icon={p.success ? Tick01Icon : Cancel01Icon}
              strokeWidth={2}
              aria-hidden="true"
            />
            {p.success ? "Success" : "Failed"}
          </Badge>
        )}
        {typeof p.duration_ms === "number" && (
          <span className="stream-duration">{number(p.duration_ms, 2)} ms</span>
        )}
        {extra && (
          <span className="stream-context-extra" title={extra}>
            {extra}
          </span>
        )}
      </div>
    </div>
  );
}

export function EventStream({
  events: latest,
  total,
  page,
  pageSize,
  loading,
  refreshing = false,
  error,
  onRetry,
  onPageChange,
  onPageSizeChange,
  onFilterProperty,
  oldest,
  onOrderChange,
  onFollow,
}: EventStreamProps) {
  const { product } = useWorkspace();
  const catalog = useEventCatalog(product?.id);
  const definitions = useMemo(() => new Map(catalog.data?.map((d) => [d.name, d])), [catalog.data]);
  const { timeZone } = useDisplayPreferences();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<{ rows: EventRow[]; total: number }>();
  const incoming = snapshot ? Math.max(0, total - snapshot.total) : 0;
  const events = incoming && snapshot ? snapshot.rows : latest;
  useEffect(() => {
    // A cached page can predate the arrivals the reader just accepted on another page.
    if (!loading && !refreshing && !error && !incoming) setSnapshot({ rows: latest, total });
  }, [latest, loading, refreshing, error, incoming, total]);
  // The inspector owns the page it opened from. Incoming events can update the
  // table without changing its record, adjacent-event navigation, or property search.
  const inspectionEvents = useRef<EventRow[]>([]);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const focusId = useRef<string | null>(null);
  const restoreFocus = useRef(true);
  const selectedIndex = inspectionEvents.current.findIndex(
    (event) => event.event_id === selectedId,
  );
  const selected = loading ? undefined : inspectionEvents.current[selectedIndex];
  function selectAdjacent(index: number) {
    const next = inspectionEvents.current[index];
    if (next) {
      focusId.current = next.event_id;
      setSelectedId(next.event_id);
    }
  }
  useEffect(() => {
    if (loading) setSelectedId(null);
  }, [loading]);
  const columns = useMemo<ColumnDef<EventRow>[]>(
    () => [
      {
        id: "event",
        header: "Event",
        cell: ({ row, table }) => {
          const event = row.original;
          const def = definitions.get(event.name);
          const icon =
            event.name === "page_view"
              ? Globe02Icon
              : event.name === "command_run"
                ? CommandLineIcon
                : CubeIcon;
          return (
            <div className="stream-event">
              <Button
                variant="ghost"
                size="sm"
                className="stream-inspect"
                aria-label={`Inspect ${event.name}`}
                ref={(button) => {
                  if (button) buttons.current.set(event.event_id, button);
                  else buttons.current.delete(event.event_id);
                }}
                onClick={() => {
                  restoreFocus.current = true;
                  focusId.current = event.event_id;
                  inspectionEvents.current = table.options.data;
                  setSelectedId(event.event_id);
                }}
              >
                {def ? (
                  <span className={`event-ink-${def.color}`}>
                    <SourceIcon name={event.name} icon={def.icon} />
                  </span>
                ) : (
                  <HugeiconsIcon
                    icon={icon}
                    strokeWidth={2}
                    aria-hidden="true"
                    data-icon="inline-start"
                  />
                )}
                <span title={def?.description || event.name}>
                  {def?.sentence ? eventSentence(def.sentence, event.properties) : event.name}
                </span>
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  strokeWidth={2}
                  aria-hidden="true"
                  data-icon="inline-end"
                />
              </Button>
              <div className="stream-event-meta">
                <Badge variant="outline" title={event.source}>
                  {product?.sources?.find((source) => source.id === event.source_id)?.name ??
                    event.source}
                </Badge>
                <time
                  className="stream-mobile-time"
                  dateTime={new Date(event.timestamp).toISOString()}
                  title={new Date(event.timestamp).toISOString()}
                >
                  {new Date(event.timestamp).toLocaleString("en-GB", {
                    timeZone,
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}{" "}
                  {timeZone}
                </time>
              </div>
            </div>
          );
        },
      },
      {
        id: "context",
        header: "Context",
        cell: ({ row }) => <EventContext event={row.original} />,
      },
      {
        id: "identity",
        header: "Identity",
        cell: ({ row }) => (
          <div className="stream-identity">
            {row.original.actor_id ? (
              <>
                <span>
                  {row.original.identity_kind === "visitor"
                    ? "Visitor"
                    : row.original.identity_kind === "installation"
                      ? "Installation"
                      : "Actor"}
                </span>
                <code title={row.original.actor_id}>{row.original.actor_id}</code>
              </>
            ) : (
              <span>Anonymous</span>
            )}
          </div>
        ),
      },
      {
        id: "time",
        header: () => <span title={timeZone}>Time</span>,
        cell: ({ row }) => (
          <time
            className="stream-time"
            dateTime={new Date(row.original.timestamp).toISOString()}
            title={new Date(row.original.timestamp).toISOString()}
          >
            <span>
              {new Date(row.original.timestamp).toLocaleTimeString("en-GB", { timeZone })}
            </span>
            <span>
              {new Date(row.original.timestamp).toLocaleDateString("en-GB", {
                timeZone,
                day: "numeric",
                month: "short",
                year: "numeric",
              })}
            </span>
          </time>
        ),
      },
    ],
    [product?.sources, timeZone, definitions],
  );
  const table = useReactTable({
    data: events,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (event) => event.event_id,
    manualPagination: true,
    rowCount: total,
    state: { pagination: { pageIndex: page, pageSize } },
  });
  const pageCount = Math.max(1, Math.min(10001, Math.ceil(total / pageSize)));
  const start = events.length ? page * pageSize + 1 : 0;
  const end = page * pageSize + events.length;
  return (
    <>
      <Card
        className="event-card event-stream"
        aria-label="Event stream"
        aria-busy={loading || refreshing}
      >
        <CardHeader>
          <div className="card-heading">
            <div>
              <CardTitle>Event stream</CardTitle>
              <CardDescription>
                <Button
                  size="sm"
                  variant="link"
                  onClick={onOrderChange}
                  aria-label={`Sort events ${oldest ? "newest" : "oldest"} first`}
                >
                  {oldest ? "Oldest first" : "Newest first"}
                </Button>
              </CardDescription>
            </div>
            {incoming ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSnapshot({ rows: latest, total });
                  if (page) onPageChange(0);
                }}
              >
                {number(incoming)} new {incoming === 1 ? "event" : "events"}
              </Button>
            ) : (
              <Badge variant="outline">{number(total)} events</Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {error ? (
            <div className="stream-message">
              <ErrorState message={error} retry={onRetry} />
            </div>
          ) : (
            <Table className="stream-table">
              <TableHeader>
                {table.getHeaderGroups().map((group) => (
                  <TableRow key={group.id}>
                    {group.headers.map((header) => (
                      <TableHead key={header.id} className={`stream-column-${header.column.id}`}>
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {!loading &&
                  table.getRowModel().rows.map((row) => (
                    <TableRow
                      key={row.id}
                      data-state={selectedId === row.id ? "selected" : undefined}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id} className={`stream-column-${cell.column.id}`}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                {!loading && !events.length && (
                  <TableRow>
                    <TableCell colSpan={columns.length}>
                      <Empty>
                        <EmptyHeader>
                          <EmptyTitle>No events on this page</EmptyTitle>
                          <EmptyDescription>
                            The results may have changed since this page was opened.
                          </EmptyDescription>
                        </EmptyHeader>
                        <Button variant="outline" onClick={() => onPageChange(0)}>
                          Return to first page
                        </Button>
                      </Empty>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
        <CardFooter className="stream-footer">
          <div
            className="stream-page-info"
            role="status"
            aria-label={loading ? "Loading events" : "Event pagination"}
          >
            <span>
              {loading
                ? "Loading events…"
                : error
                  ? "Could not load this page"
                  : `Showing ${number(start)}–${number(events.length ? end : 0)} of ${number(total)}`}
            </span>
            <span>
              Page {page + 1} of {pageCount}
            </span>
          </div>
          <div className="stream-page-actions">
            <ValueSelect
              label="Rows per page"
              value={String(pageSize)}
              options={[
                ["15", "15 rows"],
                ["30", "30 rows"],
                ["50", "50 rows"],
              ]}
              disabled={loading}
              onValueChange={(value) => onPageSizeChange(Number(value))}
              className="stream-page-size"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={loading || page === 0}
              onClick={() => onPageChange(page - 1)}
            >
              <HugeiconsIcon
                icon={ArrowLeft01Icon}
                strokeWidth={2}
                aria-hidden="true"
                data-icon="inline-start"
              />
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={loading || page + 1 >= pageCount}
              onClick={() => onPageChange(page + 1)}
            >
              Next
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                strokeWidth={2}
                aria-hidden="true"
                data-icon="inline-end"
              />
            </Button>
          </div>
        </CardFooter>
      </Card>
      <Sheet
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      >
        <SheetContent
          className="event-sheet w-full sm:max-w-[600px]"
          showCloseButton={false}
          finalFocus={() =>
            restoreFocus.current && focusId.current
              ? (buttons.current.get(focusId.current) ??
                document.querySelector<HTMLButtonElement>(".stream-inspect") ??
                false)
              : false
          }
        >
          <SheetHeader className="pr-16">
            <SheetTitle>{selected?.name ?? "Event details"}</SheetTitle>
            <SheetDescription>
              Inspect the captured values and collection metadata.
            </SheetDescription>
            <SheetClose
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Close event"
                  className="absolute right-4 top-4"
                />
              }
            >
              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} aria-hidden="true" />
            </SheetClose>
          </SheetHeader>
          {selected && (
            <>
              <div className="inspector-navigation">
                <span aria-live="polite">
                  Event {selectedIndex + 1} of {inspectionEvents.current.length} on this page
                </span>
                <div>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={oldest ? "Older event" : "Newer event"}
                    disabled={selectedIndex === 0}
                    onClick={() => selectAdjacent(selectedIndex - 1)}
                  >
                    <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} aria-hidden="true" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={oldest ? "Newer event" : "Older event"}
                    disabled={selectedIndex + 1 === inspectionEvents.current.length}
                    onClick={() => selectAdjacent(selectedIndex + 1)}
                  >
                    <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} aria-hidden="true" />
                  </Button>
                </div>
              </div>
              <EventInspector
                key={selected.event_id}
                event={selected}
                onFollow={(key, value) => {
                  restoreFocus.current = false;
                  setSelectedId(null);
                  onFollow(key, value);
                }}
                onNavigate={() => {
                  restoreFocus.current = false;
                  setSelectedId(null);
                }}
                onFilter={(property, value) => {
                  restoreFocus.current = false;
                  setSelectedId(null);
                  onFilterProperty(property, value);
                }}
              />
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

function EventInspector({
  event,
  onFilter,
  onNavigate,
  onFollow,
}: {
  event: EventRow;
  onFilter: EventStreamProps["onFilterProperty"];
  onNavigate: () => void;
  onFollow: EventStreamProps["onFollow"];
}) {
  const { product } = useWorkspace();
  const workspaceTarget = useWorkspaceTarget();
  const visit =
    event.session_id && event.actor_id && event.identity_kind === "visitor"
      ? { source_id: event.source_id, actor_id: event.actor_id, session_id: event.session_id }
      : undefined;
  const summary = useQuery({
    queryKey: ["inspector-session", product?.id, visit],
    enabled: !!visit && !!product,
    queryFn: ({ signal }) =>
      queryReadOnly<{
        page_views: number;
        events: number;
        duration_ms: number;
        start: number;
      } | null>(`/products/${product!.id}/sessions/summary`, { ...visit }, signal),
    staleTime: 15000,
    retry: false,
  });
  const { timeZone } = useDisplayPreferences();
  const [search, setSearch] = useState("");
  const [feedback, setFeedback] = useState<{ error: boolean; message: string }>();
  const properties = Object.entries(event.properties).sort(([a], [b]) => a.localeCompare(b));
  const visible = properties.filter(([key, value]) =>
    `${key} ${JSON.stringify(value)}`.toLowerCase().includes(search.toLowerCase()),
  );
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setFeedback({ error: false, message: "Copied as JSON." });
    } catch {
      setFeedback({
        error: true,
        message: "Could not copy. Select the value and copy it manually.",
      });
    }
  }
  return (
    <Tabs defaultValue="properties" className="inspector-tabs">
      <TabsList aria-label="Event details">
        <TabsTrigger value="properties" aria-label="Pretty">
          Pretty <Badge variant="secondary">{properties.length}</Badge>
        </TabsTrigger>
        <TabsTrigger value="metadata">Metadata</TabsTrigger>
        <TabsTrigger value="json">Raw JSON</TabsTrigger>
      </TabsList>
      <div className="flex flex-wrap items-center gap-2 px-4">
        <Link
          {...workspaceTarget("/events", product?.slug)}
          search={(prev) => ({
            ...prev,
            query: { ...defaultSpec, event: event.name },
            page: undefined,
            view: undefined,
            viewAt: undefined,
          })}
          onClick={onNavigate}
        >
          All events like this
        </Link>
        {(["request_id", "trace_id"] as const).map((key) => {
          const value = event.properties[key];
          if (typeof value !== "string" || !value || new TextEncoder().encode(value).length > 128)
            return null;
          return (
            <Link
              key={key}
              {...workspaceTarget("/logs", product?.slug)}
              search={{
                source: "all",
                [key === "trace_id" ? "trace" : "requestId"]: value,
                logFrom: new Date(Math.max(0, event.timestamp - 86400000)).toISOString(),
                logTo: new Date(event.timestamp + 86400000).toISOString(),
              }}
            >
              Logs for this {key === "trace_id" ? "trace" : "request"}
            </Link>
          );
        })}
        {visit && summary.data && (
          <Link
            {...workspaceTarget("/sessions", product?.slug)}
            search={{
              visit,
              from: new Date(summary.data.start).toISOString(),
              to: new Date(summary.data.start + 1).toISOString(),
              period: undefined,
              snapshot: undefined,
            }}
          >
            {number(summary.data.page_views)}{" "}
            {summary.data.page_views === 1 ? "page view" : "page views"} ·{" "}
            {number(summary.data.events)} {summary.data.events === 1 ? "event" : "events"} ·{" "}
            {Math.floor(summary.data.duration_ms / 60000)}m{" "}
            {Math.floor(summary.data.duration_ms / 1000) % 60}s
          </Link>
        )}
      </div>
      {feedback && (
        <p
          className={feedback.error ? "form-error inspector-feedback" : "inspector-feedback"}
          role={feedback.error ? "alert" : "status"}
        >
          {feedback.message}
        </p>
      )}
      <TabsContent value="properties" className="inspector-panel">
        <Field>
          <FieldLabel htmlFor="property-search" className="sr-only">
            Search properties
          </FieldLabel>
          <Input
            id="property-search"
            type="search"
            placeholder="Search properties or values…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </Field>
        <p className="inspector-hint">
          Filter actions replace the current property filter. Copy preserves the JSON type.
        </p>
        {visible.length ? (
          <div className="inspector-properties">
            {visible.map(([key, value]) => (
              <div className="inspector-property" key={key} data-property={key}>
                <div className="inspector-property-heading">
                  <code>{key}</code>
                  <Badge variant="outline">{typeof value}</Badge>
                  <div className="inspector-property-actions">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Follow ${key}`}
                      onClick={() => onFollow(key, value)}
                    >
                      Follow
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Copy ${key}`}
                      title="Copy JSON value"
                      onClick={() => void copy(JSON.stringify(value))}
                    >
                      <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Filter by ${key}`}
                      title="Filter by this value"
                      onClick={() => onFilter(key, value)}
                    >
                      <HugeiconsIcon
                        icon={FilterHorizontalIcon}
                        strokeWidth={2}
                        aria-hidden="true"
                      />
                    </Button>
                  </div>
                </div>
                <pre>
                  <TypedValue value={value} />
                </pre>
              </div>
            ))}
          </div>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>
                {properties.length ? "No matching properties" : "No properties captured"}
              </EmptyTitle>
              <EmptyDescription>
                {properties.length
                  ? "Try another property name or value."
                  : "This event was sent without custom properties."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </TabsContent>
      <TabsContent value="metadata" className="inspector-panel">
        <dl className="inspector-metadata">
          {[
            ["Event ID", event.event_id],
            ["Event name", event.name],
            [
              "Source",
              product?.sources?.find((source) => source.id === event.source_id)?.name ??
                "Unknown source",
            ],
            ["Source ID", event.source_id ?? "Not provided"],
            ["Client", event.source],
            ...Object.entries(eventContext).flatMap(([k, label]) =>
              event[k as keyof typeof eventContext]
                ? [[label, event[k as keyof typeof eventContext]]]
                : [],
            ),
            [`Event time (${timeZone})`, displayTimestamp(event.timestamp, timeZone)],
            [`Received at (${timeZone})`, displayTimestamp(event.received_at, timeZone)],
            ["Identity kind", event.identity_kind ?? "Not provided"],
            ["Actor ID", event.actor_id ?? "Not provided"],
            ["Session ID", event.session_id ?? "Not provided"],
          ].map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>
                <code>{value}</code>
              </dd>
            </div>
          ))}
        </dl>
      </TabsContent>
      <TabsContent value="json" className="inspector-panel">
        <div className="inspector-json-heading">
          <span>Original event envelope</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void copy(JSON.stringify(event, null, 2))}
          >
            <HugeiconsIcon
              icon={Copy01Icon}
              strokeWidth={2}
              aria-hidden="true"
              data-icon="inline-start"
            />
            Copy JSON
          </Button>
        </div>
        <pre className="inspector-json">
          <code>{highlight(JSON.stringify(event, null, 2), "json")}</code>
        </pre>
      </TabsContent>
    </Tabs>
  );
}
