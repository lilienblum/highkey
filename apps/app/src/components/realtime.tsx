import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { CohortPicker } from "./cohorts";
import { number, queryReadOnly } from "@/lib/api";
import { useReportQuery } from "@/lib/use-query";
import { useWorkspaceTarget } from "@/lib/workspace-route";
import { sourceParam } from "@/lib/workspace-search";
import type { realtime } from "@/server/queries/realtime";
import { PageHeader, useWorkspace, useAnalyticsPending } from "./app-shell";
import { ErrorState } from "./shared";
import { PageLoading } from "./loading";
import { WorldMap } from "./world-map";
import { TimelineMarkers } from "./chart-references";
import { Button } from "./ui/button";
import { Card, CardTitle, CardHeader, CardContent } from "./ui/card";
const load = (id: string, body: Record<string, unknown>, signal: AbortSignal) =>
  queryReadOnly<Awaited<ReturnType<typeof realtime>>>(`/products/${id}/realtime`, body, signal);
export function Realtime() {
  const { product, sourceId, refresh, refreshKey } = useWorkspace(),
    target = useWorkspaceTarget();
  const route = "/$orgSlug/$projectSlug/realtime",
    s = useSearch({ from: route }),
    nav = useNavigate({ from: route });
  const result = useReportQuery(
      load,
      "realtime",
      product?.id,
      { source_id: sourceId, cohort: s.cohort },
      refreshKey,
    ),
    r = result.data;
  useAnalyticsPending(result.refreshing);
  const wall = useRef<HTMLDivElement>(null),
    [tv, setTv] = useState(false);
  useEffect(() => {
    const sync = () => setTv(document.fullscreenElement === wall.current),
      key = (e: KeyboardEvent) => {
        if (e.key === "Escape") setTv(false);
      };
    document.addEventListener("fullscreenchange", sync);
    window.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      window.removeEventListener("keydown", key);
    };
  }, []);
  const name = (id: string) => product?.sources.find((s) => s.id === id)?.name ?? id;
  const total = r?.minutes.reduce((a, b) => a + b, 0) ?? 0;
  const time = (n: number) => new Date(n).toISOString().slice(11, 19) + " UTC";
  return (
    <div
      ref={wall}
      className={tv ? "fixed inset-0 z-50 overflow-y-auto bg-background p-4 md:p-8" : "min-w-0"}
    >
      <PageHeader
        title="Realtime"
        description="The last 30 minutes · updates while this page is visible."
      >
        <Button
          variant="outline"
          aria-pressed={tv}
          onClick={async () => {
            if (tv) {
              if (document.fullscreenElement) await document.exitFullscreen();
              setTv(false);
            } else {
              setTv(true);
              await wall.current?.requestFullscreen?.().catch(() => {});
            }
          }}
        >
          {tv ? "Exit TV mode" : "TV mode"}
        </Button>
      </PageHeader>
      {product && (
        <CohortPicker
          className="mb-4 w-fit max-w-full rounded-full sm:max-w-xs"
          project={product.id}
          value={s.cohort}
          change={(cohort) =>
            void nav({ search: (v) => ({ ...v, cohort }), state: true, resetScroll: false })
          }
        />
      )}
      {result.error && <ErrorState message={result.error} retry={refresh} />}
      {!r && result.loading && <PageLoading label="Loading live activity" />}
      {r && (
        <div className="grid min-w-0 gap-4 md:grid-cols-2">
          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle>
                {number(total)} {total === 1 ? "event" : "events"} in the last 30 minutes
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div
                className="relative flex h-20 items-end gap-1"
                role="img"
                aria-label={`Events per minute, oldest first: ${r.minutes.join(", ")}`}
              >
                {r.minutes.map((v, i) => (
                  <span
                    key={i}
                    className="min-w-0 flex-1 bg-data"
                    style={{
                      height: `${Math.max(v ? 3 : 0, (100 * v) / Math.max(1, ...r.minutes))}%`,
                    }}
                    title={`${time(Date.parse(r.from) + i * 60000)} · ${v} events`}
                  />
                ))}
                <TimelineMarkers from={r.from} to={r.to} />
              </div>
              <div className="flex justify-between text-xs">
                <span>{time(Date.parse(r.from))}</span>
                <span>{time(Date.parse(r.to))}</span>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Live events</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="max-h-72 overflow-auto">
                {r.events.map((e) => (
                  <li key={e.event_id} className="flex gap-2 border-b py-1">
                    <time className="shrink-0">{time(e.at)}</time>
                    <span className="truncate" title={e.path}>
                      {e.name} · {e.path || name(e.source_id)}
                    </span>
                  </li>
                ))}
              </ul>
              {!r.events.length && "No recent events."}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Live sessions</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="max-h-72 overflow-auto">
                {r.sessions.map((v) => (
                  <li key={JSON.stringify([v.source_id, v.actor_id, v.session_id])}>
                    <Link
                      className="block truncate border-b py-1 text-primary"
                      {...target("/sessions", product?.slug)}
                      search={{
                        source: sourceParam(product?.sources, v.source_id),
                        from: new Date(v.start).toISOString(),
                        to: new Date(v.start + 1).toISOString(),
                        visit: {
                          source_id: v.source_id,
                          session_id: v.session_id,
                          actor_id: v.actor_id,
                        },
                      }}
                    >
                      {time(v.end)} · {v.exit_page || v.session_id} · {v.page_views} views
                    </Link>
                  </li>
                ))}
              </ul>
              {!r.sessions.length && "No recently active visits."}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Countries</CardTitle>
            </CardHeader>
            <CardContent>
              <WorldMap rows={r.countries} label="Live events by country" />
              <details>
                <summary>Country counts</summary>
                {r.countries.map((c) => (
                  <p key={c.label}>
                    {c.label} · {number(c.count)}
                  </p>
                ))}
              </details>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Traffic</CardTitle>
            </CardHeader>
            <CardContent>
              {(["sources", "pages"] as const).map((k) => (
                <section key={k}>
                  <h3>Top {k}</h3>
                  <ol>
                    {r[k].map((v) => (
                      <li className="flex justify-between gap-2" key={v.label}>
                        <span className="truncate">
                          {k === "sources" ? name(v.label) : v.label}
                        </span>
                        <span>{number(v.count)}</span>
                      </li>
                    ))}
                  </ol>
                  {!r[k].length && "No activity."}
                </section>
              ))}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
