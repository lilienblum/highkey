import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { NoProduct, PageHeader, useWorkspace, useAnalyticsPending } from "./app-shell";
import { ErrorState, BreakdownRows } from "./shared";
import { PageLoading } from "./loading";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Field, FieldGroup, FieldLabel } from "./ui/field";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { number, queryReadOnly } from "@/lib/api";
import { TypedValue } from "@/lib/highlight";
import { useWorkspaceTarget } from "@/lib/workspace-route";
import { useReportQuery } from "@/lib/use-query";
import { DAY_MS } from "@/lib/date-range";
import type { peopleList, personDetail } from "@/server/queries/people";
import { GroupDirectory } from "./group-directory";
import { Cohorts, useCohorts } from "./cohorts";
import { ValueSelect } from "./value-select";

const route = "/$orgSlug/$projectSlug/people";
type Detail = Awaited<ReturnType<typeof personDetail>>;
const load = (id: string, body: Record<string, unknown>, signal: AbortSignal) =>
  queryReadOnly<Awaited<ReturnType<typeof peopleList>>>(
    `/products/${id}/people/query`,
    body,
    signal,
  );
const loadDetail = (id: string, body: Record<string, unknown>, signal: AbortSignal) =>
  queryReadOnly<Detail>(`/products/${id}/people/detail`, body, signal);
const utc = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const kinds = [
  ["identified", "Identified"],
  ["anonymous", "Anonymous"],
  ["power", "Power users"],
  ["groups", "Groups"],
] as const;
const size = 25;
export function People() {
  const { kind } = useSearch({ from: route });
  return kind === "groups" ? <GroupDirectory /> : <ProfileDirectory />;
}
function ProfileDirectory() {
  const { product, sourceId, range, refresh, refreshKey } = useWorkspace();
  const s = useSearch({ from: route }),
    navigate = useNavigate({ from: route });
  const kind = s.kind ?? "identified",
    page = s.page ?? 1;
  const cohorts = useCohorts(product?.id);
  const scope = JSON.stringify([
    sourceId,
    s.from,
    s.to,
    s.snapshot,
    s.period,
    s.days,
    s.kind,
    s.find,
    s.groupType,
    s.groupId,
    s.cohort,
    s.person,
    s.audience,
    page,
  ]);
  const list = useReportQuery(
    load,
    "people",
    s.person ? undefined : product?.id,
    {
      ...range,
      kind,
      source_id: sourceId,
      search: s.find,
      group_id: s.groupId,
      group_type: s.groupType,
      cohort: s.cohort,
      audience: s.audience,
      page,
      page_size: size,
    },
    refreshKey,
    scope,
  );
  const detail = useReportQuery(
    loadDetail,
    "person",
    s.person ? product?.id : undefined,
    {
      ...range,
      id: s.person,
      anonymous: kind === "anonymous",
      source_id: sourceId,
      page,
      page_size: size,
    },
    refreshKey,
    scope,
  );
  const active = s.person ? detail : list;
  useAnalyticsPending(!!product && active.refreshing);
  const update = (patch: Partial<typeof s>) =>
    void navigate({ search: (prev) => ({ ...prev, ...patch }), resetScroll: false });
  if (!product) return <NoProduct />;
  const title = detail.data?.traits.name;
  const more = s.person
    ? page * size <
      (s.tab === "sessions" ? (detail.data?.sessions ?? 0) : (detail.data?.events ?? 0))
    : list.data?.has_more;
  return (
    <>
      <PageHeader
        title={s.person ? (typeof title === "string" ? title : s.person) : "Profiles"}
        description={
          s.person
            ? `${kind === "anonymous" ? "Visitor" : "Profile"} · ${s.person}`
            : "Find identified people and visitors across your project."
        }
      >
        {product && !s.person && (
          <Cohorts
            id={product.id}
            select={(cohort) => update({ kind: undefined, cohort, page: undefined })}
          />
        )}
        {s.person && (
          <Button
            variant="outline"
            onClick={() => update({ person: undefined, tab: undefined, page: undefined })}
          >
            Back to profiles
          </Button>
        )}
      </PageHeader>
      <section
        className="grid min-w-0 gap-5"
        aria-label={s.person ? "Profile detail" : "Profile directory"}
      >
        {!s.person && (
          <>
            {s.audience && (
              <Button
                variant="secondary"
                className="w-fit"
                onClick={() => update({ audience: undefined, page: undefined })}
              >
                Clear chart-point filter
              </Button>
            )}
            <Tabs
              value={kind}
              onValueChange={(kind) =>
                update({
                  kind: kind === "identified" ? undefined : (kind as string),
                  cohort: kind === "anonymous" || kind === "groups" ? undefined : s.cohort,
                  page: undefined,
                })
              }
            >
              <TabsList aria-label="Profiles" variant="line">
                {kinds.map(([v, label]) => (
                  <TabsTrigger value={v} key={v}>
                    {label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            {kind !== "anonymous" && !!cohorts.data?.length && (
              <ValueSelect
                label="Cohort"
                className="max-w-xs"
                value={s.cohort ?? "*"}
                onValueChange={(v) =>
                  update({ cohort: v === "*" ? undefined : v, page: undefined })
                }
                options={[
                  ["*", "All cohorts"],
                  ...cohorts.data.map((c): [string, string] => [c.id, c.name]),
                ]}
              />
            )}
            {kind === "power" && (
              <p className="text-muted-foreground">
                Ranked by events in the 90 days ending at the selected range end.
              </p>
            )}
            <form
              key={JSON.stringify([s.find, s.groupType, s.groupId])}
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                update({
                  find: String(f.get("find") || "") || undefined,
                  groupType: String(f.get("type") || "") || undefined,
                  groupId: String(f.get("id") || "") || undefined,
                  page: undefined,
                });
              }}
            >
              <FieldGroup className="flex flex-wrap items-end gap-3 sm:flex-row">
                <Field className="min-w-40 flex-1">
                  <FieldLabel htmlFor="person-search">Name, email or ID</FieldLabel>
                  <Input
                    id="person-search"
                    name="find"
                    type="search"
                    maxLength={256}
                    defaultValue={s.find}
                  />
                </Field>
                <Field className="w-32">
                  <FieldLabel htmlFor="person-type">Group type</FieldLabel>
                  <Input id="person-type" name="type" maxLength={64} defaultValue={s.groupType} />
                </Field>
                <Field className="w-40">
                  <FieldLabel htmlFor="person-group">Group ID</FieldLabel>
                  <Input id="person-group" name="id" maxLength={128} defaultValue={s.groupId} />
                </Field>
                <Button variant="outline" type="submit">
                  Search profiles
                </Button>
              </FieldGroup>
            </form>
          </>
        )}
        {active.error && <ErrorState message={active.error} retry={refresh} />}
        {active.loading ? (
          <PageLoading label="Loading profiles" />
        ) : s.person ? (
          detail.data && (
            <Profile
              d={detail.data}
              slug={product.slug}
              to={range.to}
              tab={s.tab ?? "events"}
              setTab={(tab) => update({ tab, page: undefined })}
            />
          )
        ) : (
          list.data && (
            <>
              <Table aria-label="Profiles">
                <TableHeader>
                  <TableRow>
                    <TableHead>Profile</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Events</TableHead>
                    <TableHead>Last seen (UTC)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.data.rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>
                        <Link
                          from={route}
                          to={route}
                          search={(prev) => ({ ...prev, person: r.id, page: undefined })}
                        >
                          {r.name || r.id}
                        </Link>
                      </TableCell>
                      <TableCell>{r.email || "—"}</TableCell>
                      <TableCell>{number(r.events)}</TableCell>
                      <TableCell>{utc(r.last_seen)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {!list.data.rows.length && <p role="status">No profiles match this selection.</p>}
            </>
          )
        )}
        {(page > 1 || more) && (
          <nav aria-label="Profile pages" className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              disabled={page <= 1}
              onClick={() => update({ page: page - 1 })}
            >
              Previous
            </Button>
            <span>Page {page}</span>
            <Button
              variant="outline"
              disabled={!more || page >= 10000}
              onClick={() => update({ page: page + 1 })}
            >
              Next
            </Button>
          </nav>
        )}
      </section>
    </>
  );
}
function Profile({
  d,
  slug,
  to,
  tab,
  setTab,
}: {
  d: Detail;
  slug: string;
  to: string;
  tab: string;
  setTab: (tab: string) => void;
}) {
  const target = useWorkspaceTarget();
  const counts = new Map(d.calendar.map((r) => [r.day, r.events]));
  const end = Date.parse(to) - 1;
  const [picked, setPicked] = useState("");
  return (
    <>
      <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <div>
          <dt>Location</dt>
          <dd>{d.context.slice(0, 2).filter(Boolean).join(" · ") || "Unknown"}</dd>
        </div>
        <div>
          <dt>Device</dt>
          <dd>{d.context.slice(2).filter(Boolean).join(" · ") || "Unknown"}</dd>
        </div>
        {Object.entries({
          Events: number(d.events),
          Sessions: number(d.sessions),
          "Page views": number(d.page_views),
          "Events per session": number(d.events_per_session, 1),
          "Bounce rate": d.bounce_rate == null ? "—" : `${number(d.bounce_rate, 1)}%`,
          "Days active": number(d.days_active),
          Conversions: number(d.conversions),
          "Revenue (cents)": BigInt(d.revenue_cents).toLocaleString("en-US"),
          "p90 session length": d.p90_ms == null ? "—" : `${number(d.p90_ms / 1000, 1)}s`,
          "Average time between visits":
            d.average_gap_ms == null ? "—" : `${number(d.average_gap_ms / 3600000, 1)}h`,
        }).map(([label, v]) => (
          <div key={label}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <section aria-label="Activity calendar">
        <h2>Activity over the last year</h2>
        <div className="overflow-x-auto">
          <div
            className="grid w-max grid-flow-col grid-rows-7 gap-0.5"
            role="img"
            aria-label={`${d.calendar.length} active UTC days over the last year`}
          >
            {Array.from({ length: 365 }, (_, i) => {
              const day = new Date(end - (364 - i) * DAY_MS).toISOString().slice(0, 10),
                n = counts.get(day) ?? 0;
              const label = `${day}: ${number(n)} events`;
              return (
                <span
                  key={day}
                  className={n ? "size-2.5 bg-data" : "size-2.5 bg-muted"}
                  title={label}
                  onPointerEnter={() => setPicked(label)}
                />
              );
            })}
          </div>
        </div>
        <p className="text-muted-foreground text-xs">{picked || "Each square is one UTC day."}</p>
        <details>
          <summary>Daily event counts</summary>
          <ul>
            {d.calendar.map((r) => (
              <li key={r.day}>
                {r.day} · {number(r.events)} events
              </li>
            ))}
          </ul>
        </details>
      </section>
      <div className="grid gap-4 md:grid-cols-2">
        {(
          [
            ["Popular pages", d.pages],
            ["Top events", d.top_events],
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
      <section>
        <h2>Profile properties</h2>
        {Object.keys(d.traits).length ? (
          <dl>
            {Object.entries(d.traits).map(([k, v]) => (
              <div className="flex flex-wrap gap-2" key={k}>
                <dt>{k}</dt>
                <dd>
                  <TypedValue value={v} />
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p>No traits have been set.</p>
        )}
      </section>
      <section>
        <h2>Groups</h2>
        {d.groups.length ? (
          <ul>
            {d.groups.map(([type, id]) => (
              <li key={JSON.stringify([type, id])}>
                <Link
                  {...target("/people", slug)}
                  search={{ kind: "groups", groupType: type, groupId: id }}
                >
                  {type}: {id}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p>No group memberships on these events.</p>
        )}
      </section>
      <section>
        <h2>Cohorts</h2>
        {d.cohorts.length ? (
          <ul>
            {d.cohorts.map((c) => (
              <li key={c.id}>
                <Link
                  from={route}
                  to={route}
                  search={(v) => ({ ...v, person: undefined, cohort: c.id, page: undefined })}
                >
                  {c.name}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p>No cohort memberships.</p>
        )}
      </section>
      <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
        <TabsList variant="line" aria-label="Profile activity">
          <TabsTrigger value="events">Events</TabsTrigger>
          <TabsTrigger value="sessions">Sessions</TabsTrigger>
        </TabsList>
        <TabsContent value="events">
          <ul className="divide-y">
            {d.latest.map((e) => (
              <li key={e.event_id} className="py-2">
                {utc(e.time)} UTC · {e.name}
                <details>
                  <summary>Properties</summary>
                  <TypedValue value={e.properties} />
                </details>
              </li>
            ))}
          </ul>
          {!d.latest.length && <p>No events in this period.</p>}
        </TabsContent>
        <TabsContent value="sessions">
          <ul>
            {d.visits.map((v) => (
              <li key={JSON.stringify([v.source_id, v.actor_id, v.session_id])}>
                <Link
                  {...target("/sessions", slug)}
                  search={(prev) => ({
                    ...prev,
                    visit: {
                      source_id: v.source_id,
                      actor_id: v.actor_id,
                      session_id: v.session_id,
                    },
                    page: undefined,
                  })}
                >
                  {utc(v.start)} UTC · {v.session_id} · {number(v.events)} events
                </Link>
              </li>
            ))}
          </ul>
          {!d.visits.length && <p>No sessions in this period.</p>}
        </TabsContent>
      </Tabs>
    </>
  );
}
