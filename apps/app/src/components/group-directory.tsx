import { useNavigate, useSearch, Link } from "@tanstack/react-router";
import { PageHeader, useWorkspace, useAnalyticsPending } from "./app-shell";
import { queryReadOnly, number } from "@/lib/api";
import { useReportQuery } from "@/lib/use-query";
import type { groupActivity } from "@/server/queries/group-activity";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { ErrorState } from "./shared";
import { TypedValue } from "@/lib/highlight";
import { PageLoading } from "./loading";
import { Table, TableBody, TableRow, TableHeader, TableHead, TableCell } from "./ui/table";
const route = "/$orgSlug/$projectSlug/people";
const load = (id: string, body: Record<string, unknown>, signal: AbortSignal) =>
  queryReadOnly<Awaited<ReturnType<typeof groupActivity>>>(
    `/products/${id}/groups/activity`,
    body,
    signal,
  );
export function GroupDirectory() {
  const s = useSearch({ from: route }),
    nav = useNavigate({ from: route }),
    { product, sourceId, range, rangeScope, refresh, refreshKey } = useWorkspace();
  const update = (patch: Partial<typeof s>) =>
    nav({ search: (p) => ({ ...p, ...patch }), resetScroll: false });
  const page = s.page ?? 1,
    body = {
      ...range,
      source_id: sourceId,
      type: s.groupType,
      id: s.groupId,
      search: s.find,
      page,
    };
  const result = useReportQuery(
    load,
    "group-activity",
    product?.id,
    body,
    refreshKey,
    JSON.stringify([sourceId, rangeScope, s.groupType, s.groupId, s.find, page]),
  );
  useAnalyticsPending(result.refreshing);
  const r = result.data;
  return (
    <>
      <PageHeader
        title={s.groupId ? (r?.mode === "detail" ? r.name : s.groupId) : "Groups"}
        description={
          s.groupId
            ? `${s.groupType} · ${s.groupId}`
            : "Explore the teams, workspaces and companies on recorded events."
        }
      >
        <Button
          variant="outline"
          onClick={() =>
            update({
              kind: s.groupId ? "groups" : undefined,
              groupId: undefined,
              groupType: undefined,
              page: undefined,
              find: undefined,
            })
          }
        >
          {s.groupId ? "All groups" : "Back to profiles"}
        </Button>
      </PageHeader>
      {!s.groupId && (
        <form
          className="flex max-w-md gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            update({
              find: String(new FormData(e.currentTarget).get("find") || "") || undefined,
              page: undefined,
            });
          }}
        >
          <Input
            name="find"
            aria-label="Find a group"
            placeholder="Group name, type or ID"
            maxLength={256}
            defaultValue={s.find}
          />
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>
      )}
      {result.error && <ErrorState message={result.error} retry={refresh} />}
      {result.loading && <PageLoading label="Loading groups" />}
      {r?.mode === "list" && (
        <Table aria-label="Groups">
          <TableHeader>
            <TableRow>
              {["Group", "Type", "Active members", "Events"].map((s) => (
                <TableHead key={s}>{s}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {r.rows.map((g) => (
              <TableRow key={JSON.stringify([g.type, g.id])}>
                <TableCell>
                  <Link
                    from={route}
                    to={route}
                    search={(v) => ({
                      ...v,
                      kind: "groups",
                      groupType: g.type,
                      groupId: g.id,
                      page: undefined,
                      find: undefined,
                    })}
                  >
                    {g.name || g.id}
                  </Link>
                </TableCell>
                <TableCell>{g.type}</TableCell>
                <TableCell>{g.members}</TableCell>
                <TableCell>{g.events}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {r?.mode === "list" && !r.rows.length && <p>No groups match this selection.</p>}
      {r?.mode === "detail" && (
        <div className="grid gap-5">
          <dl className="flex flex-wrap gap-5">
            {Object.entries(r.metrics).map(([k, v]) => (
              <div key={k}>
                <dt>{k === "revenue" ? "Net cents" : k}</dt>
                <dd>{typeof v === "string" ? BigInt(v).toLocaleString("en-US") : number(v)}</dd>
              </div>
            ))}
          </dl>
          <section>
            <h2>New members over time</h2>
            <div className="max-h-48 overflow-auto">
              {r.newMembers.map((d) => (
                <div key={d.day} className="flex items-center gap-2">
                  <time>{d.day}</time>
                  <span
                    aria-hidden
                    className="h-2 bg-data-secondary"
                    style={{
                      width: `${(50 * d.members) / Math.max(...r.newMembers.map((v) => v.members), 1)}%`,
                    }}
                  />
                  {d.members}
                </div>
              ))}
            </div>
            {!r.newMembers.length && "No newly observed members."}
          </section>
          <div className="grid gap-4 md:grid-cols-2">
            <section>
              <h2>Members</h2>
              <ul>
                {r.members.map((m) => (
                  <li key={m.id}>
                    <Link
                      from={route}
                      to={route}
                      search={(v) => ({ ...v, kind: undefined, person: m.id, page: undefined })}
                    >
                      {m.id}
                    </Link>{" "}
                    · {m.events} events
                  </li>
                ))}
              </ul>
            </section>
            <section>
              <h2>Events</h2>
              <ul>
                {r.events.map((e) => (
                  <li key={e.id}>
                    {new Date(e.at).toISOString().slice(0, 19)} · {e.name}
                  </li>
                ))}
              </ul>
            </section>
          </div>
          <section>
            <h2>Group properties</h2>
            <dl>
              {Object.entries(r.traits).map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>
                    <TypedValue value={v} />
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      )}
      {r && (page > 1 || r.more) && (
        <nav aria-label="Group pages" className="flex gap-2">
          <Button
            variant="outline"
            disabled={page === 1}
            onClick={() => update({ page: page - 1 })}
          >
            Previous
          </Button>
          <span>Page {page}</span>
          <Button
            variant="outline"
            disabled={!r.more || page >= 10000}
            onClick={() => update({ page: page + 1 })}
          >
            Next
          </Button>
        </nav>
      )}
    </>
  );
}
