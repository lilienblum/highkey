import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Search01Icon,
  PlayIcon,
  PauseIcon,
  FilterHorizontalIcon,
  Cancel01Icon,
} from "@hugeicons/core-free-icons";
import { number } from "@/lib/api";
import { highlight, TypedValue } from "@/lib/highlight";
import {
  attributeValue,
  clearedLogs,
  logLevels,
  logWindows,
  minLevels,
  validateLogsSearch,
  type LogFacets,
  type LogRow,
  type LogsSearch,
} from "@/lib/logs";
import {
  getView,
  logsRunnable,
  queryToLogs,
  currentLogView,
  type LogViewDocument,
} from "@/lib/views";
import { workspaceTarget } from "@/lib/workspace-route";
import { displayTimestamp } from "@/lib/display-time";
import { PageHeader, useWorkspace } from "./app-shell";
import { useDisplayPreferences } from "./display-preferences";
import { Button } from "./ui/button";
import { CopyButton } from "./ui/copy-button";
import { Input } from "./ui/input";
import { Skeleton } from "./ui/skeleton";
import { Field, FieldLabel } from "./ui/field";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "./ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { ValueSelect } from "./value-select";
import { ErrorState, PinChip, QueryDraftNotice } from "./shared";
import { AgentGuideDialog } from "./dashboards/agent-guide";
import { ViewActions } from "./saved-views";
import { LogStream } from "./log-stream";
import { useLogFeed } from "@/lib/use-log-feed";
import { MAX_BUFFERED_LOGS } from "@/lib/log-buffer";

const direction =
  "THESIS: A compact log workspace that keeps investigation beside the stream. OWN-WORLD: Kanagawa Wave, Geist, fine seams, Base UI controls and restrained severity colors. STORY: Search a project, locate a request, inspect its structured context. FIRST VIEWPORT: Query bar, time and follow controls, shallow volume histogram, aligned timestamp/severity/service/message rows. FORM: Extend the existing shell with the requested dense stream and a right-hand inspector.";
export function Logs() {
  const { product } = useWorkspace();
  const { view, logWindow, invalidLogs } = validateLogsSearch(useSearch({ strict: false }));
  // A saved view opens by loading its filters into the URL, so reloads and history keep them. The
  // window it sets marks it as applied.
  if (product && view && !logWindow && !invalidLogs)
    return <OpenLogView key={`${product.id}:${view}`} slug={view} />;
  // Only the project remounts the explorer: a source switch keeps the stream, histogram and
  // filters in place and refreshes them.
  return <LogExplorer key={product?.id} />;
}
/** Loads the saved view named in the URL and applies its filters and window to the page. */
function OpenLogView({ slug }: { slug: string }) {
  const { product } = useWorkspace();
  const navigate = useNavigate();
  const [state, setState] = useState<"loading" | "missing" | "failed" | "unsupported">("loading");
  const [name, setName] = useState("");
  const [guiding, setGuiding] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const productSlug = product?.slug;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a retry reloads the same view
  useEffect(() => {
    if (!productSlug) return;
    const controller = new AbortController();
    setState("loading");
    getView<LogViewDocument>(productSlug, slug, "logs", controller.signal).then(
      (stored) => {
        const applied = queryToLogs(stored.document.query, stored.document.window);
        if (!logsRunnable(applied)) {
          setName(stored.document.name);
          setState("unsupported");
          return;
        }
        void navigate({
          ...workspaceTarget("/logs", productSlug),
          search: (previous: Record<string, unknown>) => ({
            ...previous,
            ...clearedLogs,
            ...applied,
            view: slug,
          }),
          replace: true,
          resetScroll: false,
        });
      },
      (error) => {
        if (!controller.signal.aborted) setState(error?.status === 404 ? "missing" : "failed");
      },
    );
    return () => controller.abort();
  }, [productSlug, slug, attempt]);
  const clear = (
    <Button
      variant="outline"
      nativeButton={false}
      role="link"
      render={
        <Link
          {...workspaceTarget("/logs", productSlug)}
          search={(previous: Record<string, unknown>) => ({ ...previous, view: undefined })}
        />
      }
    >
      {state === "unsupported" ? "Clear view" : "Clear selection"}
    </Button>
  );
  if (state === "missing")
    return (
      <>
        <PageHeader
          title="This view no longer exists"
          description="It may have been deleted. The project’s other views and its logs are unchanged."
        />
        {clear}
      </>
    );
  if (state === "unsupported")
    return (
      <>
        <PageHeader
          title="This view uses settings Logs can’t show"
          description={`${name} was saved with filters this page cannot run. Ask your agent to change it, or clear the view.`}
        />
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => setGuiding(true)}>
            Edit with your agent
          </Button>
          {clear}
        </div>
        {product && (
          <AgentGuideDialog
            open={guiding}
            onOpenChange={setGuiding}
            mode="view"
            project={product}
            view={{ slug, name, kind: "logs" }}
          />
        )}
      </>
    );
  return (
    <>
      <PageHeader title="Logs" description="Opening the saved view…" />
      {state === "failed" ? (
        <ErrorState
          message="The saved view could not be loaded."
          retry={() => setAttempt((n) => n + 1)}
        />
      ) : (
        <div className="logs-viewport" aria-hidden="true">
          <Skeleton className="h-3 w-full" />
        </div>
      )}
    </>
  );
}
function LogExplorer() {
  const { product, sourceId, now: workspaceNow } = useWorkspace();
  const { timeZone } = useDisplayPreferences();
  const search = validateLogsSearch(useSearch({ strict: false }));
  const navigate = useNavigate();
  const [draft, setDraft] = useState(search.logq ?? "");
  const [advanced, setAdvanced] = useState(
    Boolean(search.attribute || search.environment || search.trace),
  );
  const [follow, setFollow] = useState(true);
  const [selection, setSelection] = useState<{ log: LogRow; scope: string }>();
  const viewportRef = useRef<HTMLElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const window = search.logWindow ?? "1h";
  const scope = JSON.stringify([product?.id, sourceId, search]);
  // The stream and filters stay mounted across a source switch; other query changes reset them.
  const viewKey = JSON.stringify([product?.id, search]);
  const selected = selection?.scope === scope ? selection.log : undefined;
  function setSelected(log: LogRow | undefined) {
    setSelection(log ? { log, scope } : undefined);
  }
  const filters = [
    ...(search.attribute
      ? [
          {
            attribute: search.attribute,
            value: attributeValue(search.attributeValue ?? "", search.attributeType ?? "string"),
          },
        ]
      : []),
    ...(search.moreFilters ?? []),
  ];
  const query = useLogFeed(
    product?.id,
    {
      from: search.logFrom ?? new Date(workspaceNow - logWindows[window]).toISOString(),
      to: search.logTo ?? new Date(workspaceNow).toISOString(),
      source_id: search.logSource ?? sourceId,
      level: search.level,
      min_level: search.minLevel,
      service: search.service || undefined,
      environment: search.environment || undefined,
      search: search.logq || undefined,
      trace_id: search.trace || undefined,
      cursor: search.logBefore,
      filters: filters.length ? filters : undefined,
    },
    {
      windowMs: search.logBefore || search.logFrom ? undefined : logWindows[window],
      follow,
      enabled: !search.invalidLogs,
    },
  );
  const { data, error, pending } = query;
  const from = query.body.from as string;
  const to = query.body.to as string;
  const atLimit = (data?.logs.length ?? 0) >= MAX_BUFFERED_LOGS;
  // Bucket indices under a drag on the volume histogram.
  const [brush, setBrush] = useState<{ start: number; end: number } | null>(null);
  useEffect(() => setDraft(search.logq ?? ""), [search.logq]);
  function loadOlder() {
    if (pending || query.olderPending || !data?.next_cursor || atLimit) return;
    setFollow(false);
    void query.loadOlder();
  }
  function newest() {
    document.scrollingElement?.scrollTo({ top: 0 });
    setFollow(true);
    if (search.logBefore || search.logFrom) apply({});
    else void query.refresh();
  }
  function apply(next: Partial<LogsSearch>) {
    void navigate({
      ...workspaceTarget("/logs", product?.slug),
      search: (previous) => ({
        ...previous,
        logBefore: undefined,
        logFrom: undefined,
        logTo: undefined,
        invalidLogs: undefined,
        ...next,
      }),
      resetScroll: false,
    });
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (draft === (search.logq ?? "")) void query.refresh();
    else apply({ logq: draft || undefined });
  }
  if (!product)
    return <p className="quiet">Create a project in Settings to start collecting logs.</p>;
  const maximum = Math.max(1, ...(data?.series.map((b) => b.count) ?? []));
  const axisTime = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const moreFilters = search.moreFilters ?? [];
  const openView = product.views?.find(
    (candidate) => candidate.kind === "logs" && candidate.slug === search.view,
  );
  const hasFilters = Boolean(
    search.logq ||
      search.level ||
      search.minLevel ||
      search.logSource ||
      moreFilters.length ||
      search.service ||
      search.attribute ||
      search.environment ||
      search.trace,
  );
  return (
    <>
      <PageHeader
        title="Logs"
        description={`${openView ? `Saved view ${openView.name}. ` : ""}Investigate what happened across your services.`}
      >
        {openView && (
          <ViewActions<LogViewDocument>
            key={openView.id}
            product={product}
            view={openView}
            noun="filters"
            withCurrent={(stored) => currentLogView(stored, search)}
            onDeleted={() => apply({ view: undefined })}
          />
        )}
      </PageHeader>
      <section className="logs-workspace" aria-label="Project logs">
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static design provenance, with no dynamic or user content. */}
        <span hidden dangerouslySetInnerHTML={{ __html: `<!-- ${direction} -->` }} />
        <form className="logs-querybar" onSubmit={submit}>
          <div className="logs-search">
            <HugeiconsIcon icon={Search01Icon} aria-hidden="true" />
            <Input
              id="log-message-search"
              aria-label="Search log messages"
              placeholder="Search messages…"
              value={draft}
              maxLength={512}
              onChange={(e) => setDraft(e.target.value)}
            />
            <kbd>↵</kbd>
          </div>
          <Button type="submit" disabled={pending}>
            Search
          </Button>
          <div className="logs-window">
            {search.logFrom && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="logs-selected-range"
                aria-label="Clear selected range"
                onClick={() => apply({ logWindow: window })}
              >
                Selected range
                <HugeiconsIcon icon={Cancel01Icon} aria-hidden="true" />
              </Button>
            )}
            <ToggleGroup
              aria-label="Log time range"
              variant="outline"
              spacing={0}
              value={search.logFrom ? [] : [window]}
              onValueChange={(values) => {
                const next = values[0];
                if (next) apply({ logWindow: next as LogsSearch["logWindow"] });
              }}
            >
              {(
                [
                  ["15m", "Last 15 minutes"],
                  ["1h", "Last hour"],
                  ["6h", "Last 6 hours"],
                  ["24h", "Last 24 hours"],
                  ["7d", "Last 7 days"],
                ] as const
              ).map(([value, label]) => (
                <ToggleGroupItem key={value} value={value} aria-label={label} title={label}>
                  {value}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <Button
            type="button"
            variant={follow && !search.logBefore ? "secondary" : "outline"}
            aria-pressed={follow && !search.logBefore && !search.logFrom}
            onClick={() => {
              if (follow && !search.logBefore && !search.logFrom) setFollow(false);
              else newest();
            }}
          >
            <HugeiconsIcon
              icon={follow && !search.logBefore && !search.logFrom ? PauseIcon : PlayIcon}
              aria-hidden="true"
            />
            {follow && !search.logBefore && !search.logFrom ? "Following" : "Follow"}
          </Button>
        </form>
        {draft !== (search.logq ?? "") && (
          <QueryDraftNotice onDiscard={() => setDraft(search.logq ?? "")} />
        )}
        <div className="logs-filters">
          <ValueSelect
            label="Severity"
            value={search.minLevel ? `min:${search.minLevel}` : (search.level ?? "all")}
            onValueChange={(value) =>
              apply(
                value.startsWith("min:")
                  ? { level: undefined, minLevel: value.slice(4) as LogsSearch["level"] }
                  : {
                      level: value === "all" ? undefined : (value as LogsSearch["level"]),
                      minLevel: undefined,
                    },
              )
            }
            options={[
              ["all", "All levels"],
              ...logLevels.map((level): [string, string] => [level, capitalized(level)]),
              ...minLevels.map((level): [string, string] => [
                `min:${level}`,
                `${capitalized(level)} and above`,
              ]),
            ]}
          />
          <ValueSelect
            label="Service"
            value={search.service ?? "all"}
            onValueChange={(value) => apply({ service: value === "all" ? undefined : value })}
            options={[
              ["all", "All services"],
              ...Array.from(
                new Set([
                  ...((data?.facets?.services ?? data?.services)?.map((s) => s.name) ?? []),
                  ...(search.service ? [search.service] : []),
                ]),
              ).map((name) => [name, name] as [string, string]),
            ]}
          />
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={advanced}
            onClick={() => setAdvanced((v) => !v)}
          >
            <HugeiconsIcon icon={FilterHorizontalIcon} aria-hidden="true" />
            Filters{search.attribute || search.environment || search.trace ? " · Applied" : ""}
          </Button>
          <span className="logs-result-count" aria-live="polite">
            {data
              ? `${number(data.total)} ${data.total === 1 ? "record" : "records"}`
              : search.invalidLogs
                ? "Invalid query"
                : error
                  ? "Logs unavailable"
                  : "Loading logs…"}
          </span>
        </div>
        {(search.logSource || moreFilters.length > 0) && (
          <section className="drilldown-filters query-pins" aria-label="Also applied">
            {search.logSource && (
              <PinChip
                label={`Source · ${product.sources.find((s) => s.id === search.logSource)?.name ?? "unavailable"}`}
                remove="Remove source"
                onRemove={() => apply({ logSource: undefined })}
              />
            )}
            {moreFilters.map((filter, index) => (
              <PinChip
                key={`${filter.attribute}:${JSON.stringify(filter.value)}`}
                label={`${filter.attribute} = ${JSON.stringify(filter.value)}`}
                remove={`Remove filter ${filter.attribute} = ${JSON.stringify(filter.value)}`}
                onRemove={() => {
                  const next = moreFilters.filter((_, i) => i !== index);
                  apply({ moreFilters: next.length ? next : undefined });
                }}
              />
            ))}
          </section>
        )}
        {advanced && (
          <LogFilters key={viewKey} search={search} facets={data?.facets} onApply={apply} />
        )}
        {search.invalidLogs ? (
          <ErrorState
            message="This log query has invalid filters. Clear the query and try again."
            retry={() => apply(everyFilterButWindow)}
          />
        ) : (
          error && <ErrorState message={error} retry={() => void query.refresh()} />
        )}
        <div
          className="logs-volume"
          role="img"
          aria-label={
            data ? `${number(data.total)} logs in the selected time range` : "Loading log volume"
          }
        >
          {!data && pending ? (
            <Skeleton className="h-full w-full" />
          ) : (
            // HTML columns rather than a stretched SVG, so the dither tone keeps square 2px pixels.
            // Dragging across them (or clicking one) narrows the query to those buckets.
            <div
              className="logs-volume-bars"
              aria-hidden="true"
              onPointerDown={(event) => {
                if (event.button !== 0 || !data?.series.length) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                const index = bucketAt(event, data.series.length);
                setBrush({ start: index, end: index });
              }}
              onPointerMove={(event) => {
                if (brush && data) setBrush({ ...brush, end: bucketAt(event, data.series.length) });
              }}
              onPointerUp={() => {
                if (!brush || !data?.series.length) return;
                const series = data.series;
                const step =
                  series.length > 1
                    ? series[1].time - series[0].time
                    : Date.parse(to) - Date.parse(from);
                const first = Math.min(brush.start, brush.end);
                const last = Math.max(brush.start, brush.end);
                setBrush(null);
                setFollow(false);
                apply({
                  logWindow: search.logWindow,
                  logFrom: new Date(series[first].time).toISOString(),
                  logTo: new Date(Math.min(series[last].time + step, Date.parse(to))).toISOString(),
                });
              }}
              onPointerCancel={() => setBrush(null)}
            >
              {brush && data && (
                <span
                  className="logs-volume-brush"
                  style={{
                    left: `${(Math.min(brush.start, brush.end) / data.series.length) * 100}%`,
                    width: `${((Math.abs(brush.end - brush.start) + 1) / data.series.length) * 100}%`,
                  }}
                />
              )}
              {data?.series.map((bucket) => (
                <span
                  key={bucket.time}
                  className="logs-volume-bar"
                  data-empty={bucket.count ? undefined : ""}
                  style={{ height: `${(bucket.count / maximum) * 100}%` }}
                  title={`${displayTimestamp(bucket.time, timeZone)}: ${bucket.count} logs, ${bucket.errors} errors`}
                >
                  {bucket.errors > 0 && (
                    <span
                      className="logs-volume-errors"
                      style={{ height: `${(bucket.errors / bucket.count) * 100}%` }}
                    />
                  )}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="logs-volume-labels">
          <time dateTime={from} title={displayTimestamp(Date.parse(from), timeZone)}>
            {axisTime.format(Date.parse(from))}
          </time>
          <span>Log volume · {timeZone} · drag to zoom</span>
          <time dateTime={to} title={displayTimestamp(Date.parse(to), timeZone)}>
            {axisTime.format(Date.parse(to))}
          </time>
        </div>
        <div className="logs-stream" aria-busy={pending || !!query.olderPending}>
          <div className="logs-columns" aria-hidden="true">
            <span>Time</span>
            <span>Level</span>
            <span>Service</span>
            <span>Message</span>
          </div>
          {!data && pending ? (
            <div className="logs-viewport">
              {["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"].map((id) => (
                <div className="logs-placeholder" key={id}>
                  <Skeleton className="h-3 w-full" />
                </div>
              ))}
            </div>
          ) : data?.logs.length ? (
            <LogStream
              key={viewKey}
              logs={data.logs}
              timeZone={timeZone}
              viewportRef={viewportRef}
              selectedId={selected?.log_id}
              onInspect={(log, element) => {
                opener.current = element;
                setSelected(log);
              }}
              onBrowse={() => setFollow(false)}
              onLoadOlder={loadOlder}
              canLoadOlder={
                !!data.next_cursor &&
                !pending &&
                !query.olderPending &&
                !query.olderError &&
                !atLimit
              }
            />
          ) : (
            <div className="logs-viewport logs-empty">
              <h2>
                {error || search.invalidLogs
                  ? "Couldn’t load logs"
                  : hasFilters
                    ? "No matching logs"
                    : "No logs yet"}
              </h2>
              <p>
                {error || search.invalidLogs
                  ? "Retry the request above or clear the query to continue."
                  : hasFilters
                    ? "Try another search, remove a filter, or widen the time range."
                    : "Connect a service in Settings. Its logs will appear here as they arrive."}
              </p>
            </div>
          )}
        </div>
        {query.olderError && (
          <div className="logs-older-error" role="alert">
            <span>Couldn’t load older logs. {query.olderError}</span>
            <Button size="sm" variant="outline" onClick={loadOlder}>
              Retry older logs
            </Button>
          </div>
        )}
        <div className="logs-footer">
          <span>
            {data?.logs.length
              ? atLimit && data.next_cursor
                ? `Showing the newest ${number(data.logs.length)} of ${number(data.total)} records. Narrow the time range or search to see older logs.`
                : `Loaded ${number(data.logs.length)} of ${number(data.total)} ${data.total === 1 ? "record" : "records"}${query.olderPending ? " · loading older logs…" : ""}`
              : null}
          </span>
          <div>
            {(search.logBefore || (data?.logs.length ?? 0) > 100) && (
              <Button variant="ghost" size="sm" onClick={newest}>
                Back to newest
              </Button>
            )}
          </div>
        </div>
        <LogInspector
          key={selected?.log_id ?? "closed"}
          log={selected}
          finalFocus={() =>
            opener.current?.isConnected
              ? opener.current
              : (viewportRef.current?.querySelector<HTMLElement>(".log-row") ??
                document.getElementById("log-message-search"))
          }
          onClose={() => setSelected(undefined)}
          onFilter={(attribute, value) => {
            apply({
              attribute,
              attributeValue: String(value),
              attributeType: typeof value as "string" | "number" | "boolean",
            });
            setAdvanced(true);
            setSelected(undefined);
          }}
        />
      </section>
    </>
  );
}
const { logWindow: _window, ...everyFilterButWindow } = clearedLogs;
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** The histogram bucket under the pointer. */
function bucketAt(event: { clientX: number; currentTarget: HTMLElement }, count: number) {
  const rect = event.currentTarget.getBoundingClientRect();
  return Math.max(
    0,
    Math.min(count - 1, Math.floor(((event.clientX - rect.left) / rect.width) * count)),
  );
}
/** Known values first, keeping an applied value that is no longer in the window. */
function known(values: string[] | undefined, current: string) {
  return Array.from(new Set([...(values ?? []), ...(current ? [current] : [])]));
}
function LogFilters({
  search,
  facets,
  onApply,
}: {
  search: LogsSearch;
  facets?: LogFacets | null;
  onApply: (next: Partial<LogsSearch>) => void;
}) {
  const [draft, setDraft] = useState({
    environment: search.environment ?? "",
    trace: search.trace ?? "",
    attribute: search.attribute ?? "",
    value: search.attributeValue ?? "",
    type: search.attributeType ?? "string",
  });
  const [error, setError] = useState("");
  return (
    <form
      className="logs-advanced"
      onSubmit={(event) => {
        event.preventDefault();
        try {
          if (draft.attribute) attributeValue(draft.value, draft.type);
          setError("");
          onApply({
            environment: draft.environment || undefined,
            trace: draft.trace || undefined,
            attribute: draft.attribute || undefined,
            attributeValue: draft.attribute ? draft.value : undefined,
            attributeType: draft.type,
          });
        } catch (error) {
          setError((error as Error).message);
        }
      }}
    >
      {/* Environments and attribute keys are known from received logs, so they are choices. */}
      <Field>
        <FieldLabel htmlFor="log-filter-environment">Environment</FieldLabel>
        <ValueSelect
          id="log-filter-environment"
          value={draft.environment || "*"}
          onValueChange={(value) => setDraft({ ...draft, environment: value === "*" ? "" : value })}
          options={[
            ["*", "Any environment"],
            ...known(
              facets?.environments.map((item) => item.name),
              draft.environment,
            ).map((name): [string, string] => [name, name]),
          ]}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="log-filter-trace">Trace ID</FieldLabel>
        <Input
          id="log-filter-trace"
          placeholder="32-character trace ID"
          maxLength={128}
          value={draft.trace}
          onChange={(e) => setDraft({ ...draft, trace: e.target.value })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="log-filter-attribute">Attribute</FieldLabel>
        <ValueSelect
          id="log-filter-attribute"
          value={draft.attribute || "*"}
          onValueChange={(value) => {
            const key = value === "*" ? "" : value;
            const type = facets?.attributes.find((item) => item.key === key)?.type;
            setDraft({ ...draft, attribute: key, ...(type ? { type } : {}) });
          }}
          options={[
            ["*", "No attribute filter"],
            ...known(
              facets?.attributes.map((item) => item.key),
              draft.attribute,
            ).map((key): [string, string] => [key, key]),
          ]}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="log-filter-value">Value</FieldLabel>
        <Input
          id="log-filter-value"
          placeholder={
            draft.type === "number" ? "500" : draft.type === "boolean" ? "true or false" : "value"
          }
          maxLength={512}
          disabled={!draft.attribute}
          value={draft.value}
          onChange={(e) => setDraft({ ...draft, value: e.target.value })}
        />
      </Field>
      <ValueSelect
        label="Attribute type"
        value={draft.type}
        onValueChange={(type) => setDraft({ ...draft, type: type as typeof draft.type })}
        options={[
          ["string", "Text"],
          ["number", "Number"],
          ["boolean", "Boolean"],
        ]}
      />
      <Button type="submit" variant="secondary">
        Apply filters
      </Button>
      <Button
        type="button"
        variant="ghost"
        onClick={() =>
          onApply({
            environment: undefined,
            trace: undefined,
            attribute: undefined,
            attributeValue: undefined,
            attributeType: undefined,
          })
        }
      >
        Clear
      </Button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
function LogInspector({
  log,
  onClose,
  onFilter,
  finalFocus,
}: {
  log?: LogRow;
  onClose: () => void;
  onFilter: (key: string, value: string | number | boolean) => void;
  finalFocus: () => HTMLElement | null;
}) {
  const { timeZone } = useDisplayPreferences();
  const [copyError, setCopyError] = useState("");
  return (
    <Sheet
      open={!!log}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="log-inspector" side="right" finalFocus={finalFocus}>
        <SheetHeader>
          <SheetTitle>Log details</SheetTitle>
          <SheetDescription>{log?.service ?? "Structured log record"}</SheetDescription>
        </SheetHeader>
        {log && (
          <div className="log-inspector-body">
            <div className="log-inspector-meta">
              <span className="log-level" data-level={log.level}>
                {log.level}
              </span>
              <time>{displayTimestamp(log.timestamp, timeZone)}</time>
            </div>
            <p className="log-inspector-message">{log.message}</p>
            <dl className="log-context">
              {Object.entries({
                Service: log.service,
                Environment: log.environment,
                "Trace ID": log.trace_id,
                "Span ID": log.span_id,
                "Request ID": log.request_id,
                "Log ID": log.log_id,
              })
                .filter(([, value]) => value)
                .map(([name, value]) => (
                  <div key={name}>
                    <dt>{name}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
            </dl>
            <Tabs defaultValue="attributes">
              <TabsList variant="line">
                <TabsTrigger value="attributes">Attributes</TabsTrigger>
                <TabsTrigger value="raw">Raw JSON</TabsTrigger>
              </TabsList>
              <TabsContent value="attributes">
                <dl className="log-attributes">
                  {Object.entries(log.attributes).length ? (
                    Object.entries(log.attributes).map(([key, value]) => (
                      <div key={key}>
                        <dt>{key}</dt>
                        <dd>
                          {["string", "number", "boolean"].includes(typeof value) ? (
                            <button
                              type="button"
                              onClick={() => onFilter(key, value as string | number | boolean)}
                              title={`Filter by ${key}`}
                            >
                              <TypedValue value={value} />
                            </button>
                          ) : (
                            <pre>
                              <code>{highlight(JSON.stringify(value, null, 2), "json")}</code>
                            </pre>
                          )}
                        </dd>
                      </div>
                    ))
                  ) : (
                    <p className="quiet">No attributes attached.</p>
                  )}
                </dl>
              </TabsContent>
              <TabsContent value="raw">
                <pre className="log-raw">
                  <code>{highlight(JSON.stringify(log, null, 2), "json")}</code>
                </pre>
              </TabsContent>
            </Tabs>
            <CopyButton
              key={log.log_id}
              content={JSON.stringify(log, null, 2)}
              onCopyError={() =>
                setCopyError("Could not copy this record. Select the JSON from the Raw JSON tab.")
              }
            >
              Copy JSON
            </CopyButton>
            {copyError && <p role="alert">{copyError}</p>}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
