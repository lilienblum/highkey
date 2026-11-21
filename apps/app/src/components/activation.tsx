import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { HugeiconsIcon } from "@hugeicons/react";
import { InformationCircleIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { api, type Source } from "@/lib/api";
import { LiveUpdates } from "./live-updates";
import { ErrorState } from "./shared";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import type { activation } from "@/server/activation";
import { useOrganizationRole } from "./settings/settings-nav";

function useActivation(id: string, source?: string) {
  return useQuery({
    queryKey: ["activation", id, source],
    queryFn: ({ signal }) =>
      api<Awaited<ReturnType<typeof activation>>>(
        `/products/${id}/activation${source ? `?source_id=${encodeURIComponent(source)}` : ""}`,
        "GET",
        undefined,
        signal,
      ),
    retry: false,
  });
}

export function FirstEventNotice({ id, source }: { id: string; source: Source }) {
  const query = useActivation(id, source.id);
  const first = query.data?.first_event;
  return (
    <>
      {!first && (
        <LiveUpdates
          productId={id}
          scopeKey={`${id}:${source.id}`}
          view="/"
          busy={query.isFetching}
          onRefresh={() => void query.refetch()}
        />
      )}
      <Alert role="status" aria-label="Source connection" aria-atomic="true" className="min-w-0">
        <HugeiconsIcon
          icon={first ? Tick02Icon : InformationCircleIcon}
          aria-hidden="true"
          className={first ? "text-success" : "text-data"}
        />
        <AlertTitle className="line-clamp-none [overflow-wrap:anywhere]">
          {first
            ? "First event received"
            : query.isError
              ? "Couldn’t check for events"
              : query.data
                ? `Waiting for the first event from ${source.name}`
                : "Checking for the first event…"}
        </AlertTitle>
        <AlertDescription className="[overflow-wrap:anywhere]">
          {first ? (
            <p>
              {source.name} sent <code>{first.name}</code>.
            </p>
          ) : query.isError ? (
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
              Try again
            </Button>
          ) : (
            <p>
              After adding the snippet below, run your app. Its first event will appear here
              automatically.
            </p>
          )}
        </AlertDescription>
      </Alert>
    </>
  );
}

export function WebsiteCheck({ id }: { id: string }) {
  const role = useOrganizationRole();
  const [checking, setChecking] = useState(false),
    [message, setMessage] = useState("");
  async function checkSite() {
    setChecking(true);
    try {
      const result = await api<{ status: string }>(`/products/${id}/check-website`, "POST", {});
      setMessage(
        result.status === "found"
          ? "Tracker found in the site's HTML."
          : result.status === "absent"
            ? "No tracker found in the initial HTML. Bundled or dynamically loaded trackers may still send events."
            : "Could not read the site's public home page.",
      );
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setChecking(false);
    }
  }
  return role && role !== "viewer" ? (
    <div className="mt-3">
      <Button variant="outline" disabled={checking} onClick={() => void checkSite()}>
        {checking ? "Checking…" : "Check website for tracker"}
      </Button>
      <p role="status">{message}</p>
    </div>
  ) : null;
}

export function Activation({
  id,
  source,
  website,
}: {
  id: string;
  source?: string;
  website?: string | null;
}) {
  const query = useActivation(id, source);
  const d = query.data,
    first = d?.first_event;
  return (
    <Card role="region" aria-label="Activation checklist">
      <CardHeader>
        <CardTitle>Activation checklist</CardTitle>
      </CardHeader>
      <CardContent>
        <LiveUpdates
          productId={id}
          scopeKey={`${id}:${source}`}
          view="/"
          busy={query.isFetching}
          onRefresh={() => void query.refetch()}
          signals={["events", "dashboards"]}
        />
        {query.error && (
          <ErrorState message={query.error.message} retry={() => void query.refetch()} />
        )}
        {d ? (
          <ul className="grid gap-2" aria-live="polite">
            {[
              [
                !!first,
                first
                  ? `First event: ${first.name} · ${first.sdk || "Unknown SDK"} · ${first.source}`
                  : "Waiting for first event",
              ],
              [d.mcp, "Connect an agent to this project over MCP"],
              [d.dashboard, "Create a first dashboard with your agent"],
              [
                d.invited,
                <a className="text-primary underline" href="/settings/members">
                  Invite a teammate
                </a>,
              ],
            ].map(([done, label], i) => (
              <li key={i}>
                <span
                  className={done ? "text-success" : "text-muted-foreground"}
                  aria-label={done ? "Complete" : "Pending"}
                >
                  {done ? "✓" : "○"}
                </span>{" "}
                {label}
              </li>
            ))}
          </ul>
        ) : (
          !query.error && <p>Checking setup…</p>
        )}
        {website && <WebsiteCheck id={id} />}
      </CardContent>
    </Card>
  );
}
