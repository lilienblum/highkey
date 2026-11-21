import { useEffect, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useWorkspaceTarget } from "@/lib/workspace-route";
import { NoProduct, PageHeader, useWorkspace, useAnalyticsPending } from "./app-shell";
import { ErrorState, BreakdownRows } from "./shared";
import { PageLoading } from "./loading";
import { Button } from "./ui/button";
import { Field, FieldGroup, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import {
  DropdownMenu,
  DropdownMenuGroup,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
} from "./ui/dropdown-menu";
import { ValueSelect } from "./value-select";
import { queryReadOnly, type Product } from "@/lib/api";
import { readPreference, savePreference } from "@/lib/preferences";
import { useReportQuery } from "@/lib/use-query";
import type { sessionDetail, sessionList } from "@/server/queries/sessions";
import type { SessionsSearch, Visit } from "@/lib/sessions";

type List = Awaited<ReturnType<typeof sessionList>>;
type Row = List["rows"][number];
type Detail = Awaited<ReturnType<typeof sessionDetail>>;
const route = "/$orgSlug/$projectSlug/sessions";
const loadList = (id: string, q: Record<string, unknown>, signal: AbortSignal) =>
  queryReadOnly<List>(`/products/${id}/sessions/query`, q, signal);
const loadDetail = (id: string, q: Record<string, unknown>, signal: AbortSignal) =>
  queryReadOnly<Detail>(`/products/${id}/sessions/detail`, q, signal);
const labels = {
  country: "Country",
  region: "Region",
  device: "Device",
  browser: "Browser",
  browser_version: "Browser version",
  os_family: "OS",
  os_version: "OS version",
  referrer_type: "Referrer type",
  start: "Start (UTC)",
  end: "End (UTC)",
  source_id: "Source",
  actor_id: "Visitor",
  profile_id: "Profile",
  entry_page: "Entry page",
  exit_page: "Exit page",
  duration_ms: "Duration",
  page_views: "Page views",
  events: "Events",
  bounced: "Bounced",
  referrer: "Referrer",
  utm_source: "UTM source",
  utm_medium: "UTM medium",
  utm_campaign: "Campaign",
  revenue_cents: "Revenue (cents)",
} as const;
type Column = keyof typeof labels;
const columns = Object.keys(labels) as Column[];
const defaults: Column[] = [
  "start",
  "entry_page",
  "duration_ms",
  "page_views",
  "events",
  "revenue_cents",
];
const utc = (time: number) => new Date(time).toISOString().slice(0, 19).replace("T", " ");
function format(row: Row, key: Column, p: Product) {
  switch (key) {
    case "start":
    case "end":
      return utc(row[key]);
    case "bounced":
      return row.bounced ? "Yes" : "No";
    case "duration_ms":
      return `${Math.floor(row.duration_ms / 60000)}m ${Math.floor(row.duration_ms / 1000) % 60}s`;
    case "source_id":
      return p.sources.find((s) => s.id === row.source_id)?.name ?? row.source_id;
    case "utm_source":
    case "utm_medium":
    case "utm_campaign":
      return row.campaign[key] || "—";
    case "revenue_cents":
      return BigInt(row.revenue_cents).toLocaleString("en-US");
    default:
      return row[key] || "—";
  }
}
function Columns({ visible, set }: { visible: Column[]; set: (c: Column[]) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" />}>Columns</DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-80 overflow-y-auto">
        <DropdownMenuGroup>
          {columns.map((key) => (
            <DropdownMenuCheckboxItem
              key={key}
              checked={visible.includes(key)}
              closeOnClick={false}
              onCheckedChange={(checked) =>
                set(columns.filter((k) => (k === key ? checked : visible.includes(k))))
              }
            >
              {labels[key]}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Filters({ s, apply }: { s: SessionsSearch; apply: (patch: SessionsSearch) => void }) {
  const [bounce, setBounce] = useState(s.bounced === undefined ? "all" : s.bounced ? "yes" : "no");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        apply({
          find: String(data.get("find") || "") || undefined,
          views: Number(data.get("views")) || undefined,
          durationMs: Math.round(Number(data.get("seconds")) * 1000) || undefined,
          bounced: bounce === "all" ? undefined : bounce === "yes",
          page: undefined,
        });
      }}
    >
      <FieldGroup className="flex flex-wrap items-end gap-3 sm:flex-row">
        <Field className="min-w-40 flex-1">
          <FieldLabel htmlFor="session-find">Path or referrer</FieldLabel>
          <Input
            id="session-find"
            name="find"
            type="search"
            maxLength={512}
            defaultValue={s.find}
          />
        </Field>
        <Field className="w-auto">
          <FieldLabel htmlFor="session-bounce">Bounce</FieldLabel>
          <ValueSelect
            id="session-bounce"
            value={bounce}
            onValueChange={setBounce}
            options={[
              ["all", "All sessions"],
              ["yes", "Bounced"],
              ["no", "Not bounced"],
            ]}
          />
        </Field>
        <Field className="w-32">
          <FieldLabel htmlFor="session-views">Min. page views</FieldLabel>
          <Input id="session-views" type="number" min="0" name="views" defaultValue={s.views} />
        </Field>
        <Field className="w-32">
          <FieldLabel htmlFor="session-seconds">Min. seconds</FieldLabel>
          <Input
            id="session-seconds"
            type="number"
            min="0"
            step=".001"
            name="seconds"
            defaultValue={s.durationMs === undefined ? "" : s.durationMs / 1000}
          />
        </Field>
        <Button type="submit" variant="outline">
          Apply filters
        </Button>
      </FieldGroup>
    </form>
  );
}
function Pages({ page, more, set }: { page: number; more: boolean; set: (page: number) => void }) {
  if (page === 1 && !more) return null;
  return (
    <nav aria-label="Result pages" className="flex items-center justify-end gap-3">
      <Button variant="outline" disabled={page === 1} onClick={() => set(page - 1)}>
        Previous
      </Button>
      <span>Page {page}</span>
      <Button variant="outline" disabled={!more || page >= 10000} onClick={() => set(page + 1)}>
        Next
      </Button>
    </nav>
  );
}

export function Sessions() {
  const s = useSearch({ from: route }),
    navigate = useNavigate({ from: route });
  const { product, range, sourceId, refreshKey, refresh } = useWorkspace();
  const [visible, setVisible] = useState(defaults);
  useEffect(() => {
    try {
      const saved = JSON.parse(readPreference("highkey:sessions:columns:v1") ?? "null");
      if (Array.isArray(saved)) setVisible(columns.filter((k) => saved.includes(k)));
    } catch {}
  }, []);
  const update = (patch: SessionsSearch) =>
    void navigate({ search: (prev) => ({ ...prev, ...patch }), resetScroll: false });
  const invalid = s.invalidSessions || (sourceId && s.visit && s.visit.source_id !== sourceId);
  const page = s.page ?? 1;
  const scope = JSON.stringify([
    sourceId,
    s.period,
    s.days,
    s.snapshot,
    s.from,
    s.to,
    s.find,
    s.views,
    s.durationMs,
    s.bounced,
    s.profile,
    s.visit,
    page,
  ]);
  const list = useReportQuery(
    loadList,
    "sessions",
    !invalid && !s.visit ? product?.id : undefined,
    {
      ...range,
      source_id: sourceId,
      search: s.find,
      bounced: s.bounced,
      min_duration_ms: s.durationMs,
      min_page_views: s.views,
      profile_id: s.profile,
      page,
    },
    refreshKey,
    scope,
  );
  const detail = useReportQuery(
    loadDetail,
    "session-detail",
    !invalid && s.visit ? product?.id : undefined,
    { ...range, ...s.visit, page },
    refreshKey,
    scope,
  );
  const active = s.visit ? detail : list;
  useAnalyticsPending(!invalid && !!product && active.refreshing);
  if (!product) return <NoProduct />;
  if (invalid)
    return (
      <ErrorState
        message="This session selection is unavailable."
        retry={() => void navigate({ to: route, search: {} })}
      />
    );
  return (
    <>
      <PageHeader
        title={s.visit ? "Session detail" : "Sessions"}
        description={
          s.visit ? s.visit.session_id : "Inspect visits, from the entry page to the last event."
        }
      >
        {s.visit ? (
          <Button variant="outline" onClick={() => update({ visit: undefined, page: undefined })}>
            Back to sessions
          </Button>
        ) : (
          <Columns
            visible={visible}
            set={(next) => {
              setVisible(next);
              savePreference("highkey:sessions:columns:v1", JSON.stringify(next));
            }}
          />
        )}
      </PageHeader>
      <section
        className="grid min-w-0 gap-5"
        aria-label={s.visit ? "Session detail" : "Session report"}
      >
        {!s.visit && (
          <Filters
            key={JSON.stringify([s.find, s.views, s.durationMs, s.bounced])}
            s={s}
            apply={update}
          />
        )}
        {active.error && <ErrorState message={active.error} retry={refresh} />}
        {active.loading ? (
          <PageLoading label="Loading session activity" />
        ) : s.visit ? (
          detail.data && <VisitDetails d={detail.data} p={product} />
        ) : (
          list.data && (
            <>
              <Table aria-label="Sessions">
                <TableHeader>
                  <TableRow>
                    <TableHead>Session</TableHead>
                    {visible.map((k) => (
                      <TableHead key={k}>{labels[k]}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.data.rows.map((row) => {
                    const { source_id, session_id, actor_id } = row;
                    const visit: Visit = { source_id, session_id, actor_id };
                    return (
                      <TableRow key={JSON.stringify(visit)}>
                        <TableCell>
                          <Button variant="link" onClick={() => update({ visit, page: undefined })}>
                            {session_id}
                          </Button>
                        </TableCell>
                        {visible.map((k) => (
                          <TableCell key={k}>{format(row, k, product)}</TableCell>
                        ))}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              {!list.data.rows.length && (
                <p role="status">
                  No sessions match this selection. Sessions require a visitor and session ID.
                </p>
              )}
            </>
          )
        )}
        {active.data && (
          <Pages
            page={page}
            more={active.data.has_more}
            set={(n) => update({ page: n === 1 ? undefined : n })}
          />
        )}
      </section>
    </>
  );
}
function VisitDetails({ d, p }: { d: Detail; p: Product }) {
  const target = useWorkspaceTarget();
  return (
    <>
      <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {columns.map((key) => (
          <div className="min-w-0" key={key}>
            <dt className="text-xs text-muted-foreground">{labels[key]}</dt>
            <dd className="break-words">
              {key === "profile_id" && d.session.profile_id ? (
                <Link {...target("/people", p.slug)} search={{ person: d.session.profile_id }}>
                  {d.session.profile_id}
                </Link>
              ) : (
                format(d.session, key, p)
              )}
            </dd>
          </div>
        ))}
      </dl>
      <div className="grid gap-5 md:grid-cols-2">
        {(
          [
            ["Visited pages", d.pages],
            ["Event mix", d.mix],
          ] as const
        ).map(([title, rows]) => (
          <section key={title} aria-label={title}>
            <BreakdownRows
              title={title}
              groups={rows.map((r) => ({ label: r.label, count: r.n, value: r.n }))}
            />
          </section>
        ))}
      </div>
      <section aria-label="Session timeline">
        <h2>Event timeline</h2>
        <ol className="divide-y">
          {d.events.map((e) => (
            <li className="grid gap-1 py-2" key={e.event_id}>
              <time className="text-xs text-muted-foreground">{utc(e.timestamp)} UTC</time>
              <span>
                {e.name}
                {e.backfill ? " · Backfill" : ""}
              </span>
              {e.name === "ai_generation" && (
                <span>
                  {[
                    e.properties.provider,
                    e.properties.model,
                    typeof e.properties.cost === "number" && e.properties.currency === "USD"
                      ? `${e.properties.cost} USD`
                      : "",
                  ]
                    .filter(Boolean)
                    .map(String)
                    .join(" · ")}
                  {typeof e.properties.trace_id === "string" && e.properties.trace_id && (
                    <>
                      {" · "}
                      <Link
                        {...target("/ai", p.slug)}
                        search={{
                          trace: e.properties.trace_id,
                          from: new Date(d.session.start).toISOString(),
                          to: new Date(d.session.end + 1).toISOString(),
                        }}
                      >
                        View AI trace
                      </Link>
                    </>
                  )}
                </span>
              )}
              <details>
                <summary>Event properties</summary>
                <pre className="whitespace-pre-wrap break-all">
                  {JSON.stringify(e.properties, null, 2)}
                </pre>
              </details>
            </li>
          ))}
        </ol>
      </section>
      <section aria-label="Related logs">
        <h2>Related logs</h2>
        {d.logs.length ? (
          <ul className="divide-y">
            {d.logs.map((l) => (
              <li key={l.log_id} className="break-words py-2">
                {utc(l.time)} UTC · {l.service} · {l.level}
                <br />
                {l.message}
              </li>
            ))}
          </ul>
        ) : (
          <p>No logs share a request or trace ID during this visit.</p>
        )}
        {d.more_logs && <p>Showing the first 50 matching logs.</p>}
      </section>
    </>
  );
}
