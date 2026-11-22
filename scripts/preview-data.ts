import type { Event, Properties } from "../sdk/typescript/client";

const day = 86_400_000;
const first = ["Ari", "Bea", "Cleo", "Dev", "Emi", "Finn", "Ira", "Jules"];
const last = ["Chen", "Diaz", "Hart", "Ito", "Kim", "Lin", "Patel", "Rivera"];
const teams = [
  "Paper Kite",
  "Cedar Studio",
  "Lumen Labs",
  "Signal House",
  "Night Garden",
  "Alto Works",
];
const pages = ["/", "/docs", "/templates", "/pricing", "/changelog", "/guides/first-release"];
const channels = ["Direct", "google.com", "github.com", "news.ycombinator.com", "duckduckgo.com"];
export const sources = ["Website", "iOS app", "CLI"] as const;
type Source = (typeof sources)[number];
type Log = {
  log_id: string;
  timestamp: string;
  service: string;
  level: string;
  message: string;
  environment: string;
  trace_id: string;
  request_id: string;
  attributes: Properties;
};
const iso = (at: number) => new Date(at).toISOString();

/** IDs, times and values for a completed visit stay the same across seed runs. */
export function previewData(now: number, created: number) {
  const today = Math.floor(now / day),
    launch = Math.floor(created / day) - 1;
  const events: Record<Source, Event[]> = { Website: [], "iOS app": [], CLI: [] };
  const logs: Log[] = [];
  const origin = iso((Math.floor(created / day) - 29) * day);
  if (now - Date.parse(origin) < 89 * day) {
    teams.forEach((name, i) =>
      events.Website.push({
        source: "server",
        event_id: `team-${i}`,
        timestamp: origin,
        record_type: "group",
        name: "group_update",
        group_type: "workspace",
        group_id: `studio-${i}`,
        group_name: name,
        traits: { plan: i % 2 ? "Team" : "Studio", seats: 6 + i * 3 },
      }),
    );
    for (let i = 0; i < 64; i++) {
      const name = `${first[i % 8]} ${last[Math.floor(i / 8)]}`;
      events.Website.push({
        source: "server",
        event_id: `person-${i}`,
        timestamp: origin,
        record_type: "identify",
        name: "profile_identify",
        profile_id: `member-${i}`,
        traits: {
          name,
          email: `${name.toLowerCase().replace(" ", ".")}@example.invalid`,
          plan: i % 3 ? "Team" : "Free",
        },
      });
    }
  }
  function visit(start: number, index: number, key: string, surface: Source) {
    const person = index % 64,
      signedIn = index % 7 !== 0,
      cli = surface === "CLI";
    const source = cli ? "cli" : surface === "Website" ? "browser" : "ios";
    const trace = Bun.SHA256.hash(key, "hex").slice(0, 32),
      request = `req-${key}`;
    const groups = signedIn ? { workspace: `studio-${person % teams.length}` } : undefined;
    const base = {
      source,
      profile_id: signedIn ? `member-${person}` : undefined,
      groups,
      actor_id: `${cli ? "install" : "visitor"}-${index % 131}`,
      identity_kind: cli ? ("installation" as const) : ("visitor" as const),
      session_id: cli ? undefined : `visit-${key}`,
    };
    const record = (offset: number, name: string, properties: Properties) => {
      if (start + offset <= now)
        events[surface].push({
          ...base,
          event_id: `e-${key}-${offset}`,
          timestamp: iso(start + offset),
          name,
          properties,
        });
    };
    const version = Math.floor(start / day) < launch ? "2.7.1" : "2.8.0";
    const referrer =
      Math.floor(start / day) === launch && index % 2 === 0
        ? "producthunt.com"
        : channels[index % channels.length];
    const entry = pages[index % 9 < 4 ? 0 : 1 + (index % 5)];
    const duration = 90 + (index % 840),
      failed = index % 23 === 0;
    if (surface === "Website") {
      record(0, "page_view", {
        path: entry,
        referrer,
        utm_source: referrer === "producthunt.com" ? "launch" : "organic",
      });
      if (index % 4)
        record(18_000, "page_view", {
          path: index % 2 ? "/docs/quickstart" : "/pricing",
          referrer,
        });
      if (index % 9 === 0) record(52_000, "signup_completed", { path: "/welcome", plan: "Free" });
    } else if (cli) {
      record(0, "command_run", {
        command: ["build", "check", "publish"][index % 3],
        version,
        os: ["macos", "linux", "windows"][index % 3],
        success: !failed,
        duration_ms: duration,
        request_id: request,
      });
    } else {
      record(0, "screen_view", {
        screen: ["Inbox", "Projects", "Activity"][index % 3],
        os: "iOS",
        version,
      });
      record(15_000, "project_opened", { screen: "Project", version, duration_ms: duration });
    }
    if (signedIn && index % 5 === 0)
      record(68_000, "ai_generation", {
        provider: "openai",
        model: index % 2 ? "gpt-4.1-mini" : "gpt-4.1",
        input_tokens: 450 + (index % 1400),
        output_tokens: 110 + (index % 430),
        latency_ms: duration + 310,
        cost: (2 + (index % 19)) / 1000,
        currency: "USD",
        error: failed,
        trace_id: trace,
        request_id: request,
        feature: "release_notes",
      });
    if (signedIn && index % 13 === 0)
      record(92_000, "purchase", {
        path: "/checkout/thanks",
        revenue: index % 2 ? 2900 : 7900,
        currency: "USD",
        plan: index % 2 ? "Solo" : "Team",
      });
    const at = start + 70_000;
    if (at <= now && now - at < 6 * day)
      logs.push({
        log_id: `log-${key}`,
        timestamp: iso(at),
        trace_id: trace,
        request_id: request,
        service: cli ? "build-worker" : index % 5 === 0 ? "notes-api" : "gateway",
        environment: "demo",
        level: failed ? "error" : index % 11 === 0 ? "warn" : "info",
        message: failed
          ? "Upstream timed out; retry scheduled"
          : index % 11 === 0
            ? "Queue latency above target"
            : cli
              ? "Build completed"
              : index % 5 === 0
                ? "Release notes generated"
                : "Request completed",
        attributes: { status: failed ? 504 : 200, duration_ms: duration, version, client: source },
      });
  }
  for (let d = today - 29; d <= today; d++) {
    const date = new Date(d * day),
      weekday = date.getUTCDay();
    const count =
      (weekday === 0 || weekday === 6 ? 64 : 108) +
      Math.round(13 * Math.sin(d)) +
      (d >= launch ? 46 : 0);
    for (let i = 0; i < count; i++) {
      const index = d * 193 + i,
        start = d * day + Math.floor(((i + 0.5) / count) * day);
      visit(start, index, `${d}-${i}`, i % 10 < 6 ? "Website" : i % 10 < 8 ? "iOS app" : "CLI");
    }
  }
  // Give the default five-minute live card and one-hour log stream something to inspect immediately.
  for (let minute = Math.floor(now / 60_000) - 29; minute <= Math.floor(now / 60_000); minute++)
    visit(minute * 60_000, minute, `live-${minute}`, sources[minute % 3]);
  return { events, logs };
}
