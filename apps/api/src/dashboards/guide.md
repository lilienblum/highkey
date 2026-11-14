# Building Piko dashboards

A dashboard is one JSON document of widgets. Each widget runs typed queries over a project's events and logs (or one guarded SQL query), combines them with formulas, and picks a view. Piko validates every document, times every widget before it saves, and answers mistakes with JSON paths and hints.

Work in this order: `describe_project`, then `run_widget` for each widget, then `validate_dashboard`, then `save_dashboard`. `run_widget` returns the newest 200 points of each series and the first 50 rows of a table, with a warning when it trims. `sample_events` and `sample_logs` show real rows when a name or property is unclear.

## The document

```json
{
  "version": 1,
  "name": "Checkout health",
  "description": "Optional, up to 280 characters",
  "widgets": []
}
```

- `version` is `1`. `name` is 1-80 characters and becomes the dashboard's slug. `$schema` is optional; the full JSON Schema is the `piko://schema/dashboard.v1` resource.
- A widget has `id` (`[a-z0-9-]`, up to 40), `title` (1-80 characters), `view`, `queries`, and optionally `series`, `size`, `range`, `timeout_ms` and `description`.
- Unknown fields are errors, so a misspelt field is reported at its path rather than ignored.

## Queries

`queries` maps a query id (`[a-z][a-z0-9_]{0,15}`) to a query. A widget has 1-4 queries, and every query must be used by a series.

**Events**: `{"signal": "events", "event": "checkout", "measure": "count"}`.

- `measure` is `count` (default), `actors`, `sum`, `avg`, `p50`, `p95`, `min` or `max`. The last six need a numeric `property`.
- `filters` (at most 8) are `{"property": "plan", "op": "eq", "value": "pro"}` with `op` of `eq`, `ne`, `gt`, `gte`, `lt` or `lte`. Ordered comparisons need a number.
- `group_by` is `name`, `source`, `source_id`, `identity_kind` or `property:<key>`. `source_id` and `identity_kind` scope the query.

**Logs**: `{"signal": "logs", "min_level": "error", "service": "checkout"}`.

- `level` matches one level exactly; `min_level` (`warn`, `error` or `fatal`) matches that level and above. Use one of them. Levels are trace, debug, info, warn, error, fatal.
- Also `service`, `environment`, `source_id`, `search` (message text, up to 512 bytes) and `filters` of `{"attribute": "region", "value": "eu"}`.
- `measure` is `count`, or `sum`, `avg`, `p50`, `p95`, `min`, `max` over a numeric `attribute`. `group_by` is `level`, `service`, `environment` or `attribute:<key>`.

**SQL**: `{"signal": "sql", "database": "events", "sql": "SELECT ..."}` runs one read-only DuckDB `SELECT` (up to 8,000 characters) over the project's own `events` or `logs` table. Piko verifies that the statement is a single SELECT, that it uses only that table, no side-effecting functions, and only the named parameters `$from`, `$to` (epoch milliseconds), `$bucket` (hour, day, week or month) and `$source` (a source id, or NULL for all). Functions that can build values larger than the server's memory are refused (the list is not exhaustive; other routes, such as nested `replace` calls, can still grow a value): `repeat`, `lpad`, `rpad`, `bitstring`, `printf`, `format`, `bar`, `list_resize`, `array_resize`, and the list forms of `range` and `generate_series` (their table forms, as in `SELECT i FROM range(10) t(i)`, are fine). `WITH RECURSIVE` is refused too. Each refusal's hint says what to use instead. Piko then dry-runs the query on the project's data. `describe_project` lists the table columns under `sql`. Results stop at 10,000 rows with a warning. Result columns decide the shape: `value` (one number); `time` and `value`, plus an optional `group` (a time series); `label` and `value` (a ranking); or any columns for a `table`. `missing` is `null` (default) or `zero` for absent buckets.

Every query in a widget must share the same `group_by`. Event queries read events; logs and SQL over logs read the logs database, which keeps 31 days.

## Series and formulas

`series` is a list of 1-4 `{"expr": "...", "label": "...", "color": "...", "unit": "...", "thresholds": [...]}`. Without `series`, each query is a series. `expr` is arithmetic over query ids: `+ - * /`, parentheses, numbers, a unary minus, and the functions `abs(x)`, `min(a, b)` and `max(a, b)`, for example `errors / requests * 100`. A formula is at most 200 characters. Division by zero gives no value, not an error. An unknown id is reported with the nearest known one.

A grouped time series (`group_by` on a line, area or bar) allows one series and at most 6 groups. Rankings need a `group_by` (or an SQL `label` and `value`).

## Views

`view.type` is one of:

- `stat`: one headline number, with an optional `sparkline`.
- `line`, `area`, `bar`: a time series; `stacked` for area and bar; `bucket` is `auto`, `hour`, `day`, `week` or `month`.
- `ranking`: the top groups; `limit` is 1-50 (default 10).
- `events`, `logs`: a list of the newest rows. They take exactly one query of their own signal, count measure, no `group_by` and no series.
- `table`: arbitrary columns from one SQL query; no series.
- `text`: Markdown in `view.markdown` (up to 2,000 characters), no queries.

Display options: `unit` (`number`, `percent`, `ratio`, `ms`, `seconds`, `bytes`), `decimals` (0-4), `prefix` and `suffix` (up to 8 characters each).

## Compare and better

Stat, line, area and bar widgets compare with the previous period of the same length unless `view.compare` is `none`. `compare: "previous_period"` asks for it on other views. A grouped series has no previous period; a ranking compares totals. Growth is coloured as good or bad by `view.better`: `up` (default) or `down` when lower is better. Durations (`ms`, `seconds`) default to `down`. Each comparison runs the queries again, so a widget may run at most 8 queries per refresh, including previous periods.

## Colors and thresholds

Colors are `yellow`, `violet`, `aqua`, `green`, `red` and `neutral`. A series' `color` is optional; the default cycles yellow, violet, aqua. `thresholds` are `{"at": 5, "color": "red"}` entries in ascending `at`: the value takes the color of the highest threshold it reaches.

## Sizes and ranges

`size` is `{"w": 6, "h": 2}` on a 12-column grid: `w` is 3, 4, 6, 8 or 12 and `h` is 1, 2 or 3. Defaults: stat 3x1, charts and rankings 6x2, text 4x1, lists and tables 12x3.

A widget's `range` is `24h` or `30d` (1-3 digits and `h` or `d`); otherwise it follows the date range chosen in Piko. Event ranges are clamped to 366 days, logs to 31 days and hourly buckets to 31 days. A clamp is never an error: `run_widget` reports `range.clamped` and a warning. `timeout_ms` is 1,000-10,000 (default 5,000).

## Limits

- 50 dashboards per project and 100 saved views per project. A document is at most 65,536 bytes with at most 24 widgets.
- Saves are timed: a widget slower than 1 s saves with a warning, one over 3 s (or its `timeout_ms`) is refused as `too_slow`. A save has 15 s in total.
- A project accepts 30 dashboard and view writes per minute across HTTP and MCP. Failed attempts count. Over the limit you get `rate_limited` and `retry_after_secs`.
- A dashboard keeps its newest 50 revisions plus the newest of each origin. `restore_revision` is the undo.

## Saved views

A view is a named query for the Events page (`"kind": "events"`, the default) or the Logs page (`"kind": "logs"`). Use `save_view`; it creates when `view` is absent and replaces that view in full when present. An events view holds an events query as `query`. A logs view holds only filters (`level` or `min_level`, `service`, `environment`, `source_id`, `search`, `filters`) and an optional `window` of `15m`, `1h`, `6h`, `24h` or `7d`.

An events view and a logs view may share a slug. Then pass `kind` to `get_view`, `delete_view` and `save_view` (in the document), or the call fails with `ambiguous_view`.

```json view
{
  "version": 1,
  "kind": "logs",
  "name": "Checkout errors",
  "query": { "min_level": "error", "service": "checkout" },
  "window": "1h"
}
```

```json view
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

## Errors

A failing tool returns its error body as a tool result marked as an error. Read `errors[].path` (a JSON Pointer into what you sent) and `errors[].hint`, fix the document, and save again.

```json
{
  "error": "Invalid dashboard document",
  "code": "invalid_document",
  "errors": [
    {
      "path": "/widgets/0/series/0/expr",
      "message": "unknown query `requets` at column 1; did you mean `requests`?",
      "hint": null
    }
  ],
  "warnings": []
}
```

Codes: `invalid_document`, `not_found` (the hint names the nearest slug), `revision_conflict` (re-read the dashboard, merge, save with the new `revision` as `base_revision`), `too_slow`, `busy` and `query_timeout` (retry or narrow the widget), `limit`, `rate_limited`, `ambiguous_view`, `confirm_mismatch`, `invalid_argument` (a bad tool argument), `invalid_kind`, `invalid_input`, `conflict` and `internal`. The full table is in the Piko docs, `docs/api.md`. Warnings never block a save: an unknown event name or property only warns, because the data may arrive later.

## Workspace tools

Besides dashboards, the full MCP manages the workspace. Every tool takes `project` as an id or slug; sources are an id or slug, keys are ids.

- Projects: `create_project` (retention defaults to 365 days), `update_project` (only the given fields change; `website_url: ""` clears the website).
- Sources: `list_sources`, `create_source`, `update_source`, and `connect_source`, which creates a source plus an ingestion key and returns ready-to-paste setup snippets with the secret filled in. Replace `PIKO_URL` in them with the origin of the Piko URL this server is reached at. The secret is shown only once. `icon` is one of website, ios, android, mobile, terminal, desktop, server, code, package, game, generic.
- Ingestion keys: `list_keys`, `create_key`, `update_key_origins`, `revoke_key`.
- Logs: `list_log_keys`, `create_log_key`, `revoke_log_key`, `get_log_settings`, `update_log_settings` (retention 1-365 days, 7 by default).
- Tools that revoke keys (`revoke_key`, `revoke_log_key`) and tools that delete (`delete_dashboard`, `delete_view`) need `confirm` equal to the id or slug. A mismatch is a `confirm_mismatch` error and nothing changes.
- The read path (`/api/read/mcp`) has only `list_sources` and `get_log_settings` from this group; key tools and every change are on the full path.
- Validation errors name the argument in `errors[].path` (for example `/icon` or `/allowed_origins`) with a hint, and the code is `invalid_input`, `not_found` or `conflict`.

## Examples

A stat that compares with the previous period, where fewer is better:

```json document
{
  "version": 1,
  "name": "Support load",
  "widgets": [
    {
      "id": "tickets",
      "title": "Tickets opened",
      "view": { "type": "stat", "compare": "previous_period", "better": "down", "sparkline": true },
      "queries": { "tickets": { "signal": "events", "event": "ticket_opened" } }
    }
  ]
}
```

A chart of an error rate, from logs over events, with a formula, thresholds and a size:

```json document
{
  "version": 1,
  "name": "Checkout health",
  "widgets": [
    {
      "id": "error-rate",
      "title": "Checkout error rate",
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

A table from SQL, bounded by the range parameters:

```json document
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

Weekly churn, in SQL: actors active the week before and not this week, bucketed by week, leaving the current partial week out:

```json document
{
  "version": 1,
  "name": "Retention",
  "widgets": [
    {
      "id": "weekly-churn",
      "title": "Weekly churned actors",
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
