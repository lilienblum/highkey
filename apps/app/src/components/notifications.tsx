import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "@/lib/api";
import { useWorkspaceTarget } from "@/lib/workspace-route";
import type { notificationHistory } from "@/server/notifications";
import { Button } from "./ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "./ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
import { Input } from "./ui/input";
import { ValueSelect } from "./value-select";
import { oversees, useOrganizationRole } from "./settings/settings-nav";

type History = Awaited<ReturnType<typeof notificationHistory>>;
type Item = { id: string; name: string; kind: string };
type Config = { rules: Item[]; destinations: Item[] };
function useHistory(project: string, before?: number) {
  return useQuery({
    queryKey: ["notification-history", project, before ?? null],
    queryFn: ({ signal }) =>
      api<History>(
        `/products/${project}/notifications/history${before ? `?before=${before}` : ""}`,
        "GET",
        undefined,
        signal,
      ),
    refetchInterval: before ? false : 10000,
  });
}
export function NotificationToast({ project }: { project: string }) {
  const history = useHistory(project),
    seen = useRef<number | null>(null),
    [notice, setNotice] = useState<History[number]>();
  useEffect(() => {
    if (!history.data || history.error) return;
    const first = history.data[0],
      latest = first?.seq ?? 0;
    if (first && seen.current !== null && latest > seen.current) setNotice(first);
    seen.current = latest;
  }, [history.data, history.error]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), 10000);
    return () => clearTimeout(timer);
  }, [notice]);
  return notice && !history.error ? (
    <aside
      role="status"
      className="fixed bottom-4 right-4 z-40 max-w-[min(24rem,90vw)] break-words rounded-lg border bg-popover p-4"
    >
      <strong>{notice.rule_name}</strong>
      <p>{notice.message}</p>
      <Button variant="ghost" size="sm" onClick={() => setNotice(undefined)}>
        Dismiss notification
      </Button>
    </aside>
  ) : null;
}
export function Notifications({ id, slug }: { id: string; slug: string }) {
  const admin = oversees(useOrganizationRole()),
    target = useWorkspaceTarget(),
    [mode, setMode] = useState<"rules" | "destinations" | null>(null),
    [before, setBefore] = useState<number>(),
    [kind, kindSet] = useState("event"),
    [dest, setDest] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const root = `/products/${id}/notifications`,
    history = useHistory(id, before),
    config = useQuery({
      queryKey: ["notification-config", id],
      enabled: admin,
      queryFn: ({ signal }) => api<Config>(root + "/config", "GET", undefined, signal),
    });
  const action = async (f: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await f();
      await config.refetch();
      setMode(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  function form(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget),
      text = (k: string) => String(f.get(k) ?? "").trim();
    void action(() => {
      const body =
        mode === "rules"
          ? {
              kind,
              name: text("name"),
              steps: text("steps")
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
              filters: JSON.parse(text("filters") || "[]"),
              template: text("template"),
              destination: dest || null,
            }
          : {
              kind,
              name: text("name"),
              url: text("url"),
              email: text("email"),
              headers: JSON.parse(text("headers") || "{}"),
              body: JSON.parse(text("body") || '{"text":"{{message}}"}'),
            };
      return api(`${root}/${mode}`, "POST", body);
    });
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <CardDescription>Review what fired and where it was delivered.</CardDescription>
      </CardHeader>
      <CardContent className="grid min-w-0 gap-4">
        {admin && (
          <>
            <div className="flex flex-wrap gap-2">
              {(["rules", "destinations"] as const).map((m) => (
                <Button
                  variant="outline"
                  key={m}
                  onClick={() => {
                    setMode(m);
                    kindSet(m === "rules" ? "event" : "webhook");
                    setDest("");
                    setError("");
                  }}
                >
                  {m === "rules" ? "New rule" : "New destination"}
                </Button>
              ))}
            </div>
            {config.data &&
              (["rules", "destinations"] as const).map((m) => (
                <ul key={m}>
                  {config.data[m].map((i) => (
                    <li
                      key={i.id}
                      className="flex flex-wrap items-center justify-between gap-2 border-b py-1"
                    >
                      <span>
                        {i.name} · {i.kind}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        aria-label={`Remove ${i.name}`}
                        onClick={() => void action(() => api(`${root}/${m}/${i.id}`, "DELETE"))}
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              ))}
          </>
        )}
        {((!mode && error) || config.error || history.error) && (
          <p role="alert">{error || config.error?.message || history.error?.message}</p>
        )}
        <h3>Notification history</h3>
        {history.data?.length === 0 && <p>No notifications in this part of history.</p>}
        <ol>
          {history.data?.map((n) => (
            <li key={n.seq} className="grid gap-1 border-b py-2">
              <strong>{n.rule_name}</strong>
              <p className="break-words">{n.message}</p>
              <small>
                {new Date(n.at_ms).toISOString().slice(0, 19)} UTC · {n.status}
              </small>
              <div className="flex gap-3">
                {n.event_id && n.event_ms != null && (
                  <Link
                    {...target("/events", slug)}
                    search={{
                      drilldown: {
                        productId: id,
                        from: new Date(n.event_ms).toISOString(),
                        to: new Date(n.event_ms + 1000).toISOString(),
                        sourceId: n.source_id ?? undefined,
                        filter: { property: "event.id", value: n.event_id },
                      },
                    }}
                  >
                    View event
                  </Link>
                )}
                {n.profile_id && (
                  <Link {...target("/people", slug)} search={{ person: n.profile_id }}>
                    View profile
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ol>
        <div className="flex gap-2">
          {before && (
            <Button variant="outline" onClick={() => setBefore(undefined)}>
              Newest
            </Button>
          )}
          {history.data?.length === 50 && (
            <Button variant="outline" onClick={() => setBefore(history.data!.at(-1)!.seq)}>
              Older
            </Button>
          )}
        </div>
        <Dialog
          open={!!mode}
          onOpenChange={(v) => {
            if (!v && !busy) setMode(null);
          }}
        >
          <DialogContent className="max-h-[85dvh] overflow-auto">
            <DialogHeader>
              <DialogTitle>
                {mode === "rules" ? "New notification rule" : "New destination"}
              </DialogTitle>
              <DialogDescription>
                {mode === "rules"
                  ? "Choose what fires and who hears about it."
                  : "Webhook addresses and headers are write-only."}
              </DialogDescription>
            </DialogHeader>
            {mode && (
              <form onSubmit={form} className="grid gap-3">
                <label>
                  Name
                  <Input name="name" maxLength={80} required />
                </label>
                <ValueSelect
                  label="Type"
                  value={kind}
                  onValueChange={kindSet}
                  options={
                    mode === "rules"
                      ? [
                          ["event", "Event"],
                          ["funnel", "Completed session funnel"],
                          ["health", "Data health"],
                          ["digest", "Weekly digest"],
                        ]
                      : [
                          ["webhook", "HTTPS webhook"],
                          ["slack", "Slack"],
                          ["discord", "Discord"],
                          ["email", "Email (SMTP)"],
                        ]
                  }
                />
                {mode === "rules" ? (
                  <>
                    {["event", "funnel"].includes(kind) && (
                      <>
                        <label>
                          {kind === "funnel"
                            ? "Ordered events, separated by commas"
                            : "Event or @custom event"}
                          <Input name="steps" required />
                        </label>
                        <details>
                          <summary>Property filters</summary>
                          <label>
                            Typed filters (JSON array)
                            <Input
                              name="filters"
                              placeholder={'[{"property":"plan","op":"eq","value":"pro"}]'}
                            />
                          </label>
                        </details>
                      </>
                    )}
                    <label>
                      Message template
                      <Input name="template" placeholder="{{name}}" maxLength={1024} />
                    </label>
                    <ValueSelect
                      label="Destination"
                      value={dest || "dashboard"}
                      onValueChange={(v) => setDest(v === "dashboard" ? "" : v)}
                      options={[
                        ["dashboard", "Dashboard only"],
                        ...(config.data?.destinations ?? []).map(
                          (d) => [d.id, d.name] as [string, string],
                        ),
                      ]}
                    />
                  </>
                ) : kind === "email" ? (
                  <label>
                    Project member email
                    <Input type="email" name="email" required />
                  </label>
                ) : (
                  <>
                    <label>
                      Webhook URL
                      <Input name="url" required type="url" autoComplete="off" />
                    </label>
                    {kind === "webhook" && (
                      <>
                        <label>
                          Headers (JSON object)
                          <Input
                            type="password"
                            name="headers"
                            autoComplete="off"
                            placeholder="{}"
                          />
                        </label>
                        <label>
                          Body template (JSON)
                          <Input name="body" placeholder={'{"text":"{{message}}"}'} />
                        </label>
                      </>
                    )}
                  </>
                )}
                {error && <p role="alert">{error}</p>}
                <Button type="submit" disabled={busy}>
                  {mode === "rules" ? "Save rule" : "Save destination"}
                </Button>
              </form>
            )}
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
