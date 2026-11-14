# Custom dashboards, saved views and MCP

Piko dashboards are JSON documents that the API owns. A dashboard is a list of widgets; each widget runs typed queries over a project's events and logs (or one guarded SQL query), combines them with formulas, and picks a view. Saved views are named queries for the Events and Logs pages.

Nobody drags widgets around in Piko. You describe what you want to your AI agent, and it builds the document over [MCP](#ask-your-ai). Piko validates every save, times every widget before it saves, keeps revisions, and answers mistakes with JSON paths and hints. The page shows the result: dashboards appear under Overview in the sidebar, views under Events and Logs. See [the dashboard guide](dashboard.md#dashboards) for the UI.

The same document works over plain HTTP ([API reference](api.md#dashboards-views-and-mcp)), so scripts and your own pages can use it too. The JSON Schema is served at `/api/read/schemas/dashboard.v1.json` and over MCP as `piko://schema/dashboard.v1`. `apps/api/src/dashboards/guide.md` is what agents read as `piko://docs/dashboards`; it follows this page.

## Ask your AI

Piko serves an MCP server (streamable HTTP) in the API. It has two paths:

| Path            | Tools                                                                                       | Use it with                 |
| --------------- | ------------------------------------------------------------------------------------------- | --------------------------- |
| `/mcp`          | Everything: read, build and save dashboards and views, manage projects, sources and keys    | A full Access service token |
| `/api/read/mcp` | Read only: projects, catalog, `run_widget`, samples, dashboards and views to read, validate | A read-only token           |

`/mcp` is served by the dashboard and forwards to the API's own `/api/mcp`. Use `/api/mcp` only when an agent reaches the API directly, without the dashboard in front. The read-only server stays at `/api/read/mcp` so Access can scope a read token to `/api/read/*`.

Piko has no login of its own. Cloudflare Access is the boundary, so a remote agent presents an Access [service token](access.md#mcp-and-read-only-access). Locally (`bun dev`, standalone or Compose) there is no Access and the agent needs no headers.

### Claude Code

Locally, through the dashboard:

```sh
claude mcp add --transport http piko http://127.0.0.1:3000/mcp
```

Against a deployment behind Access, add the service token's two headers:

```sh
claude mcp add --transport http piko https://piko.example.com/mcp \
  --header "CF-Access-Client-Id: <client id>.access" \
  --header "CF-Access-Client-Secret: <client secret>"
```

Claude Code does not expand environment variables inside a remote server's URL or headers, so paste the literal values. `claude mcp add` does not check them; run `/mcp` inside Claude Code to confirm the connection (a wrong token shows the HTTP status, such as 401). For a read-only agent use `/api/read/mcp` and the read token instead.

### Codex

Add a server to `~/.codex/config.toml`:

```toml
[mcp_servers.piko]
url = "https://piko.example.com/mcp"
http_headers = { "CF-Access-Client-Id" = "<client id>.access", "CF-Access-Client-Secret" = "<client secret>" }
```

To keep the secret out of the file, use `env_http_headers`, which maps a header name to the name of an environment variable:

```toml
[mcp_servers.piko]
url = "https://piko.example.com/mcp"
http_headers = { "CF-Access-Client-Id" = "<client id>.access" }
env_http_headers = { "CF-Access-Client-Secret" = "PIKO_ACCESS_CLIENT_SECRET" }
```

Locally, `url = "http://127.0.0.1:3000/mcp"` is enough.

### What the agent can do

Every tool takes `project` as an id or slug. Start with `describe_project`.

| Tool                                                          | Path | What it does                                                                                           |
| ------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------ |
| `list_projects`, `describe_project`                           | both | Projects. Event names and properties, log services and levels, sources, retention, SQL columns, limits |
| `run_widget`                                                  | both | Runs one widget and returns series or rows, the range used, warnings and `elapsed_ms`                  |
| `sample_events`, `sample_logs`                                | both | Up to 20 of the newest raw events or logs of the last 7 days                                           |
| `list_dashboards`, `get_dashboard`, `list_revisions`          | both | Read dashboards and their revisions                                                                    |
| `validate_dashboard`                                          | both | Checks a document without saving; returns `{valid, errors, warnings}`                                  |
| `list_views`, `get_view`                                      | both | Read saved views                                                                                       |
| `list_sources`, `get_log_settings`                            | both | Sources of a project; log retention                                                                    |
| `save_dashboard`, `restore_revision`, `delete_dashboard`      | full | Create or replace (with `base_revision`), undo, delete                                                 |
| `save_view`, `delete_view`                                    | full | Create or replace a view; delete it                                                                    |
| `create_project`, `update_project`                            | full | Projects and their retention                                                                           |
| `create_source`, `update_source`, `connect_source`            | full | Sources; `connect_source` also makes an ingestion key and returns setup snippets                       |
| `list_keys`, `create_key`, `update_key_origins`, `revoke_key` | full | Ingestion keys                                                                                         |
| `list_log_keys`, `create_log_key`, `revoke_log_key`           | full | Log keys                                                                                               |
| `update_log_settings`                                         | full | Log retention (1-365 days)                                                                             |

`delete_dashboard`, `delete_view`, `revoke_key` and `revoke_log_key` need a `confirm` argument equal to the slug (dashboard, view) or id (keys). A mismatch changes nothing and returns `confirm_mismatch`.

The server also offers the resources `piko://schema/dashboard.v1` and `piko://docs/dashboards`, and a prompt, `build_dashboard`, that walks an agent through describe, run, validate and save.

A good request names the project and the outcome: "In project orbit, create a dashboard Checkout health with the checkout error rate and p95 latency by service." The agent should preview each widget with `run_widget`, validate, then save. A save is refused if the document is invalid or a widget is too slow, with a JSON path and a hint, so the agent can fix it and try again.

What the agent can see and change is a trust decision: read [privacy](privacy.md#ai-agents-and-mcp) before you hand out the full token.

## The document

```json
{
  "version": 1,
  "name": "Checkout health",
  "description": "Optional, up to 280 characters",
  "widgets": []
}
```

- `version` is `1`. `name` is 1-80 characters and becomes the dashboard's slug (`Checkout` and a second `Checkout` become `checkout` and `checkout-2`; a name with no letters or digits becomes `dashboard`). `$schema` is optional.
- A widget has `id` (`[a-z0-9-]`, up to 40), `title` (1-80 characters), `view`, `queries`, and optionally `series`, `size`, `range`, `timeout_ms` and `description` (up to 280 characters; shown as a hint beside the title).
- Unknown fields are errors, so a misspelt field is reported at its path rather than ignored.

### Queries

`queries` maps a query id (`[a-z][a-z0-9_]{0,15}`) to a query. A widget has 1-4 queries, and every query must be used by a series. All queries in a widget must share the same `group_by`.

**Events**: `{"signal": "events", "event": "checkout", "measure": "count"}`

- `measure` is `count` (default), `actors`, `sum`, `avg`, `p50`, `p95`, `min` or `max`. The last six need a numeric `property`.
- `filters` (at most 8) are `{"property": "plan", "op": "eq", "value": "pro"}` with `op` of `eq`, `ne`, `gt`, `gte`, `lt` or `lte`. Ordered comparisons need a number.
- `group_by` is `name`, `source`, `source_id`, `identity_kind` or `property:<key>`. `source_id` and `identity_kind` also scope the query.

**Logs**: `{"signal": "logs", "min_level": "error", "service": "checkout"}`

- `level` matches one level exactly; `min_level` (`warn`, `error` or `fatal`) matches that level and above. Use one of them. The levels are trace, debug, info, warn, error and fatal.
- Also `service`, `environment`, `source_id`, `search` (message text, up to 512 bytes) and `filters` of `{"attribute": "region", "value": "eu"}`.
- `measure` is `count`, or `sum`, `avg`, `p50`, `p95`, `min` or `max` over a numeric `attribute`. `group_by` is `level`, `service`, `environment` or `attribute:<key>`.

**SQL**: `{"signal": "sql", "database": "events", "sql": "SELECT ..."}`. See [guarded SQL](#guarded-sql).

### Formulas

`series` is a list of 1-4 `{"expr": "...", "label": "...", "color": "...", "unit": "...", "thresholds": [...]}`. Without `series`, each query is a series.

`expr` is arithmetic over query ids: `+ - * /`, parentheses, numbers, a unary minus, and the functions `abs(x)`, `min(a, b)` and `max(a, b)`. For example `errors / requests * 100`. A formula is at most 200 characters and 16 levels deep. Division by zero gives no value rather than an error, so a bucket with no requests is a gap. An unknown id is reported with the nearest known one.

A grouped time series (`group_by` on a line, area or bar) allows one series and at most 6 groups. Rankings need a `group_by` (or an SQL `label` and `value`).

### Guarded SQL

A widget can run one read-only DuckDB `SELECT` of up to 8,000 characters over the project's own `events` or `logs` table. It is how you build things the typed queries cannot, such as churn.

Piko checks the statement before every save, validation and run. DuckDB's own parser must report one statement that is a `SELECT`; it may read only that database's table, may call no side-effecting function, and may use only these named parameters:

| Parameter | Meaning                                            |
| --------- | -------------------------------------------------- |
| `$from`   | Start of the range, epoch milliseconds (inclusive) |
| `$to`     | End of the range, epoch milliseconds (exclusive)   |
| `$bucket` | `hour`, `day`, `week` or `month`                   |
| `$source` | A source id, or `NULL` for all sources             |

The `events` table has `name`, `source`, `source_id`, `event_time` (epoch ms), `received_at`, `actor_id`, `identity_kind`, `session_id` and `properties` (JSON). The `logs` table has `log_id`, `source_id`, `timestamp` (epoch ms), `received_at`, `level`, `message`, `service`, `environment`, `trace_id`, `span_id`, `request_id` and `attributes` (JSON). `describe_project` returns the exact columns with their types.

The result's column names decide its shape:

| Columns                           | Shape                         | Views                 |
| --------------------------------- | ----------------------------- | --------------------- |
| `value`                           | one number                    | `stat`                |
| `time`, `value`, optional `group` | a time series (one per group) | `line`, `area`, `bar` |
| `label`, `value`                  | a ranking                     | `ranking`             |
| anything (up to 50 columns)       | a table                       | `table`               |

A query may also set `"missing": "zero"` so absent buckets count as 0; the default is `null`, which draws a gap. Results stop at 10,000 rows (and 4 MiB) with a warning. DECIMAL, HUGEINT and other big integers arrive as strings in run results so no digits are lost. Queries run in a transaction that is rolled back, under the widget's `timeout_ms`.

Always bound the query with `$from` and `$to`, and filter early. A widget that takes more than 3 seconds on the last 7 days is refused at save time.

## Views

`view.type` is one of:

| Type                  | Shows                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `stat`                | One headline number, with an optional `sparkline`                                               |
| `line`, `area`, `bar` | A time series. `stacked` for area and bar. `bucket` is `auto`, `hour`, `day`, `week` or `month` |
| `ranking`             | The top groups; `limit` is 1-50 (default 10)                                                    |
| `events`, `logs`      | The newest rows. Exactly one query of its own signal, count measure, no `group_by`, no series   |
| `table`               | Arbitrary columns from one SQL query; no series                                                 |
| `text`                | Markdown in `view.markdown` (up to 2,000 characters), no queries                                |

Display options: `unit` (`number`, `percent`, `ratio`, `ms`, `seconds`, `bytes`), `decimals` (0-4), and `prefix` and `suffix` (up to 8 characters each). A series' own `unit` wins over the view's.

### Compare and better

Stat, line, area and bar widgets compare with the previous period of the same length, and show it as, for example, "+15% vs prior 7d" in a small tile or "+15% vs previous 7 days" on a larger one. Set `view.compare` to `"none"` to opt out, or `"previous_period"` to ask for it on other views. A grouped series has no previous period; a ranking compares totals. A previous value of 0 or none shows a dash. Each comparison runs the queries again, so a widget may run at most 8 queries per refresh, counting previous periods.

`view.better` says which direction is good, so growth is coloured as an outcome: `up` (default) or `down` when lower is better. Durations (`ms` and `seconds`) default to `down`.

## Colors and thresholds

Colors are `yellow`, `violet`, `aqua`, `green`, `red` and `neutral`. There is no orange (orange marks actions) and no hex. A series' `color` is optional; the default cycles yellow, violet, aqua.

A chart has only three accent hues. When a series reuses a hue that an earlier series already has, as grouped series 4-6 do, it is drawn in a dither tone instead: a dotted line and a checkered fill of the same hue, so it stays distinguishable from the solid one. Give series explicit colors when you want to control which ones.

`thresholds` are `{"at": 5, "color": "red"}` entries in ascending `at`. The value takes the color of the highest threshold it reaches.

## Layout

The grid has 12 columns. `size` is `{"w": 6, "h": 2}` with `w` of 3, 4, 6, 8 or 12 and `h` of 1, 2 or 3. Defaults: stat 3x1, line, area, bar and ranking 6x2, text 4x1, events, logs and table 12x3. On medium screens widths 3 and 4 become 6 and 8 becomes 12; on narrow screens every widget is full width. Widgets keep document order.

A widget's `range` is `24h` or `30d` (one to three digits, then `h` or `d`); without one it follows the date range chosen in Piko. `timeout_ms` is 1,000-10,000 (default 5,000).

## Limits

| Limit                                       | Value                                             |
| ------------------------------------------- | ------------------------------------------------- |
| Dashboards per project                      | 50                                                |
| Saved views per project (both kinds)        | 100                                               |
| Document size                               | 65,536 bytes                                      |
| Widgets per dashboard                       | 24                                                |
| Queries / series per widget                 | 4 / 4                                             |
| Query runs per widget, with previous period | 8                                                 |
| Groups in a grouped series                  | 6                                                 |
| Ranking `limit`                             | 1-50 (default 10)                                 |
| Filters per query                           | 8                                                 |
| Formula                                     | 200 characters, 16 levels deep                    |
| SQL                                         | 8,000 characters, 10,000 rows, 50 table columns   |
| Name or title / description / markdown      | 1-80 / 280 / 2,000 characters                     |
| `id` / query id                             | `[a-z0-9-]{1,40}` / `[a-z][a-z0-9_]{0,15}`        |
| Revisions kept                              | The newest 50, plus the newest of each origin     |
| Writes                                      | 30 per minute per project (HTTP and MCP together) |

### Clamping and retention

A range that is too long is clamped, never an error. Event queries show at most the newest 366 days, log queries (and SQL over logs) 31 days, and hourly buckets are limited to 31 days (a longer hourly range uses an automatic bucket). `run_widget` reports `range.clamped` with the requested range and a warning, and the widget's footer reads "Newest 31 days".

Retention is separate: events are kept for the project's retention (365 days for new projects) and logs for the log retention (7 days by default, 1-365). Older buckets are simply empty, and a widget that reads logs over a longer range says "Logs kept 7 days" in its footer. An unknown event name or property only warns, because the data may arrive later.

### Saves are checked and timed

Every save is validated, SQL is verified against the project's data, and each new or changed widget runs once over the last 7 days (or its own `range`). A widget takes at most the smaller of its `timeout_ms` and 3 seconds, and a whole save has 15 seconds. A widget slower than 1 second saves with a warning; one that exceeds its budget is refused as `too_slow`. Unchanged widgets are not timed again.

Writes are limited to 30 per minute per project, shared by HTTP and MCP, and failed attempts count. Over the limit you get `429 rate_limited` with `Retry-After`.

A save that is based on a stale revision fails with `409 revision_conflict`; read the dashboard again, merge, and save with the new `revision` as `base_revision`. Revisions can be browsed and restored in the UI (**Revisions** in the dashboard menu) or with `restore_revision`. Each revision records its origin: `dashboard` (the page), `api` or `mcp`.

### Errors

Failures return `{ "error", "code", "errors": [{ "path", "message", "hint" }], "warnings" }`. `path` is a JSON Pointer into what you sent. MCP tool errors carry the same body, plus `retry_after_secs` where HTTP would send `Retry-After`. The full list of codes, with statuses and what to do, is in [the API reference](api.md#error-codes).

## Saved views

A view is a named query for the Events page (`"kind": "events"`, the default) or the Logs page (`"kind": "logs"`). They are small and have no revisions: a save replaces the document. An events view holds an events query; a logs view holds only filters and an optional `window` of `15m`, `1h`, `6h`, `24h` or `7d` (a view that names none opens on the last hour).

An events view:

```json piko-view
{
  "version": 1,
  "name": "Pro signups by plan",
  "query": {
    "event": "signup",
    "measure": "count",
    "filters": [{ "property": "plan", "op": "eq", "value": "pro" }],
    "group_by": "property:plan"
  }
}
```

A logs view:

```json piko-view
{
  "version": 1,
  "kind": "logs",
  "name": "Checkout errors",
  "description": "Errors and worse from the checkout service",
  "query": { "min_level": "error", "service": "checkout" },
  "window": "1h"
}
```

An events view and a logs view may share a slug. Then pass `kind` to get, delete and (inside the document) save, or the call fails with `ambiguous_view`. See [the dashboard guide](dashboard.md) for how the pages open them.

## Worked examples

Each block below is checked against the schema and the validation rules by `cargo test -p piko --test dashboards_docs`. Paste one into `validate_dashboard`, or ask your agent for something like it.

### Checkout error rate

Error logs divided by checkout requests, from two signals in one formula. The widget looks at the last 24 hours and goes red above 5%.

```json piko-dashboard
{
  "version": 1,
  "name": "Checkout health",
  "widgets": [
    {
      "id": "error-rate",
      "title": "Checkout error rate",
      "description": "Error logs from the checkout service per checkout request",
      "view": { "type": "line", "unit": "percent", "decimals": 1, "better": "down" },
      "size": { "w": 6, "h": 2 },
      "range": "24h",
      "queries": {
        "errors": { "signal": "logs", "min_level": "error", "service": "checkout" },
        "requests": { "signal": "events", "event": "checkout_request" }
      },
      "series": [
        {
          "expr": "errors / requests * 100",
          "label": "Error rate",
          "color": "red",
          "thresholds": [{ "at": 1, "color": "yellow" }, { "at": 5, "color": "red" }]
        }
      ]
    }
  ]
}
```

### p95 latency by service

One logs query grouped by service gives one line per service (up to 6; the fourth to sixth are dithered). Durations compare with the previous period as "lower is better" by default.

```json piko-dashboard
{
  "version": 1,
  "name": "Latency",
  "widgets": [
    {
      "id": "p95-by-service",
      "title": "p95 latency by service",
      "view": { "type": "line", "unit": "ms", "decimals": 0 },
      "size": { "w": 12, "h": 2 },
      "queries": {
        "p95": {
          "signal": "logs",
          "measure": "p95",
          "attribute": "duration_ms",
          "group_by": "service"
        }
      }
    }
  ]
}
```

### Conversion with thresholds

A stat of signups per visit as a percent. It is red under 2%, yellow from 2%, green from 5%, with a sparkline and a comparison with the previous period.

```json piko-dashboard
{
  "version": 1,
  "name": "Conversion",
  "widgets": [
    {
      "id": "conversion",
      "title": "Signup conversion",
      "view": { "type": "stat", "unit": "percent", "decimals": 1, "sparkline": true },
      "queries": {
        "signups": { "signal": "events", "event": "signup" },
        "visits": { "signal": "events", "event": "page_view" }
      },
      "series": [
        {
          "expr": "signups / visits * 100",
          "label": "Conversion",
          "thresholds": [
            { "at": 0, "color": "red" },
            { "at": 2, "color": "yellow" },
            { "at": 5, "color": "green" }
          ]
        }
      ]
    }
  ]
}
```

### Weekly churn in SQL

Churn is not a typed measure, so this uses SQL. A person churned in a week when they were active (sent any event with an `actor_id`) the week before and not this week. The widget buckets by week, lower is better, and the current partial week is left out so it does not look like a drop. Change `actor_id` to whatever identity you collect.

```json piko-dashboard
{
  "version": 1,
  "name": "Retention",
  "widgets": [
    {
      "id": "weekly-churn",
      "title": "Weekly churned actors",
      "description": "Actors active the week before and not in this week",
      "view": { "type": "bar", "bucket": "week", "better": "down" },
      "size": { "w": 12, "h": 2 },
      "queries": {
        "churned": {
          "signal": "sql",
          "database": "events",
          "missing": "zero",
          "sql": "WITH active AS (SELECT DISTINCT actor_id, date_trunc('week', epoch_ms(event_time)) AS week FROM events WHERE actor_id IS NOT NULL AND event_time >= $from - 604800000 AND event_time < $to AND ($source IS NULL OR source_id = $source)) SELECT previous.week + INTERVAL 7 DAY AS time, count(*) AS value FROM active previous LEFT JOIN active this ON this.actor_id = previous.actor_id AND this.week = previous.week + INTERVAL 7 DAY WHERE this.actor_id IS NULL AND previous.week + INTERVAL 7 DAY < date_trunc('week', epoch_ms($to)) GROUP BY 1"
        }
      }
    }
  ]
}
```

A table is just as direct; this one lists the busiest events in the range:

```json piko-dashboard
{
  "version": 1,
  "name": "Events by name",
  "widgets": [
    {
      "id": "by-name",
      "title": "Events by name",
      "view": { "type": "table" },
      "queries": {
        "q": {
          "signal": "sql",
          "database": "events",
          "sql": "SELECT name, count(*) AS events FROM events WHERE event_time >= $from AND event_time < $to GROUP BY name ORDER BY events DESC LIMIT 20"
        }
      }
    }
  ]
}
```

## Local pages

Because the read paths are plain HTTP, you can write your own page against a project (a wallboard, a status page, a README badge generator) and keep it wherever you like. Under `/api/read/*` every request is non-mutating whatever its method, so a read-only token can be scoped to that prefix. These paths answer cross-origin requests from an allowlist:

- **Loopback origins are allowed by default**: `http://localhost`, `http://127.0.0.1` and `http://[::1]` (HTTP or HTTPS) with any port.
- **Other origins are added with `PIKO_CORS_ORIGINS`**, a comma-separated list of exact origins (scheme, host and port; no trailing slash and no path), for example `PIKO_CORS_ORIGINS=https://wall.example.com,http://192.168.1.20:8080`. Set it on the API process; see [Compose](compose.md#cors-for-read-only-pages).
- **`null` is never allowed.** A page opened from disk (`file://`) has the `null` origin, so serve it instead: `python3 -m http.server 8000` or `bunx serve` in its folder, then open `http://localhost:8000`.
- A literal `*` in `PIKO_CORS_ORIGINS` is accepted by the code and allows every origin. Don't use it: the allowlist is the point, and with Access in front the origin you list is the only page that should read your data.
- Credentials are never enabled, no write path sends CORS headers at all, and the only request headers allowed are `Content-Type`, `CF-Access-Client-Id` and `CF-Access-Client-Secret`.

Against a deployment behind Access, a browser's CORS preflight carries no credentials and Access answers it with 403. In the Access application that covers `/api/read/*`, turn on **Bypass options requests to origin** (under Cross-Origin Resource Sharing settings) so Piko answers the preflight, and send the read-only service token's two headers on the real request. Anything in a page's source is readable by whoever opens it, so only put a read-only token in a page you serve to yourself.

This page asks one widget for its result and prints the numbers. Locally it works as is; edit `piko` and the `headers` for a deployment.

```html
<!doctype html>
<meta charset="utf-8" />
<title>Signups, last 7 days</title>
<h1 id="title">Loading…</h1>
<p id="value"></p>
<p id="change"></p>
<script type="module">
  const piko = "http://127.0.0.1:3000"; // or https://piko.example.com
  const project = "orbit"; // a project slug or id
  const headers = { "Content-Type": "application/json" };
  // Deployed behind Access, add the read-only token here:
  // headers["CF-Access-Client-Id"] = "<client id>.access";
  // headers["CF-Access-Client-Secret"] = "<client secret>";

  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 3600 * 1000);
  const widget = {
    id: "signups",
    title: "Signups",
    view: { type: "stat" },
    queries: { signups: { signal: "events", event: "signup" } },
  };

  const response = await fetch(`${piko}/api/read/products/${project}/widgets/run`, {
    method: "POST",
    headers,
    body: JSON.stringify({ widget, from: from.toISOString(), to: to.toISOString() }),
  });
  const body = await response.json();
  if (!response.ok) {
    document.getElementById("title").textContent = body.error;
  } else {
    const [series] = body.series; // { label, total, previous_total, points: [{ time, value }] }
    document.getElementById("title").textContent = widget.title;
    document.getElementById("value").textContent = series.total ?? "—";
    document.getElementById("change").textContent = series.previous_total
      ? `${Math.round(((series.total - series.previous_total) / series.previous_total) * 100)}% vs the 7 days before`
      : "";
  }
</script>
```

`from` and `to` are RFC 3339 times; `bucket` and `source_id` are optional. The result holds `series` (or `rows` and `columns` for lists and tables), `range`, `warnings` and `elapsed_ms`. A saved dashboard's widgets are at `GET /api/read/products/{project}/dashboards/{dashboard}`; run them one by one with the same call.
