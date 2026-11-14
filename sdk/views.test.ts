import { expect, test } from "bun:test";
import {
  defaultSpec,
  validateExploreSearch,
  type ExploreSpec,
} from "../apps/dashboard/src/lib/explore-search";
import { validateLogsSearch } from "../apps/dashboard/src/lib/logs";
import {
  appliedState,
  currentLogView,
  eventViewState,
  explorable,
  logPageState,
  logViewState,
  rememberApplied,
  viewSync,
  logsRunnable,
  logsToQuery,
  queryToLogs,
  type LogViewDocument,
  queryToSpec,
  specToQuery,
  validViewSlug,
  viewErrorMessage,
  type EventViewQuery,
} from "../apps/dashboard/src/lib/views";

const spec = (patch: Partial<ExploreSpec>): ExploreSpec => ({ ...defaultSpec, ...patch });
const makeSpec = spec;

test("the default Explore spec saves as a plain grouped count and reads back unchanged", () => {
  const query = specToQuery(defaultSpec);
  expect(query).toEqual({ measure: "count" });
  expect(queryToSpec(query)).toEqual(defaultSpec);
});

test("supported Explore fields survive a round trip through an events query", () => {
  const specs = [
    spec({ event: "signup", measure: "actors", group: "source_id" }),
    spec({ event: "cli_run", measure: "p95", property: "duration_ms", group: "property:os" }),
    spec({ measure: "sum", property: "amount", group: "identity_kind" }),
    spec({ event: "signup", filterProperty: "plan", filterOp: "eq", filterValue: "pro" }),
    spec({ filterProperty: "success", filterOp: "ne", filterValue: "true" }),
    spec({ filterProperty: "seats", filterOp: "gte", filterValue: "10" }),
    // A quoted value is a string, not the number or boolean its text would parse as.
    spec({ filterProperty: "code", filterOp: "eq", filterValue: '"42"' }),
    spec({ filterProperty: "flag", filterOp: "eq", filterValue: '"true"' }),
  ];
  for (const original of specs) expect(queryToSpec(specToQuery(original))).toEqual(original);
});

test("filter values are typed the way the query builder types them", () => {
  const filter = (filterValue: string) =>
    specToQuery(spec({ filterProperty: "p", filterOp: "eq", filterValue })).filters?.[0].value;
  expect(filter("pro")).toBe("pro");
  expect(filter("42")).toBe(42);
  expect(filter("true")).toBe(true);
  expect(filter('"42"')).toBe("42");
  expect(filter("null")).toBe("null");
});

test("measures without a numeric property save without one", () => {
  expect(specToQuery(spec({ measure: "count", property: "duration_ms" })).property).toBeUndefined();
  expect(specToQuery(spec({ measure: "actors" })).property).toBeUndefined();
  expect(specToQuery(spec({ measure: "avg", property: "latency" })).property).toBe("latency");
});

test("the client name is not part of a saved view", () => {
  const query = specToQuery(spec({ event: "signup", source: "browser" }));
  expect(JSON.stringify(query)).not.toContain("browser");
  expect(queryToSpec(query).source).toBe("");
});

test("every events query field survives a round trip through the Events page", () => {
  const queries: EventViewQuery[] = [
    { measure: "count" },
    { event: "signup", measure: "count", group_by: "property:plan" },
    { measure: "min", property: "seconds", group_by: "source_id" },
    { measure: "max", property: "seconds", group_by: "identity_kind" },
    {
      event: "signup",
      source_id: "0197f0f2-0000-7000-8000-000000000000",
      identity_kind: "anonymous",
      measure: "p95",
      property: "duration_ms",
      group_by: "property:plan",
      filters: [
        { property: "plan", op: "eq", value: "pro" },
        { property: "region", op: "ne", value: "eu" },
        { property: "seats", op: "gte", value: 10 },
        { property: "beta", op: "eq", value: true },
        { property: "code", op: "eq", value: "42" },
        { property: "a", op: "eq", value: "x" },
        { property: "b", op: "lt", value: 1.5 },
        { property: "c", op: "gt", value: -2 },
      ],
    },
  ];
  for (const query of queries) {
    const spec = queryToSpec(query);
    expect(explorable(spec)).toBe(true);
    expect(specToQuery(spec)).toEqual(query);
    // And through the URL the page keeps it in.
    const parsed = validateExploreSearch(JSON.parse(JSON.stringify({ query: spec })));
    expect(parsed.invalidQuery).toBeUndefined();
    expect(parsed.query).toEqual(spec);
  }
});

test("extra filters, a pinned source and identity kind become page state", () => {
  const spec = queryToSpec({
    event: "signup",
    measure: "avg",
    property: "seconds",
    group_by: "property:plan",
    source_id: "0197f0f2-0000-7000-8000-000000000000",
    identity_kind: "anonymous",
    filters: [
      { property: "plan", op: "eq", value: "pro" },
      { property: "region", op: "eq", value: "eu" },
    ],
  });
  expect(spec).toEqual(
    makeSpec({
      event: "signup",
      measure: "avg",
      property: "seconds",
      group: "property:plan",
      filterProperty: "plan",
      filterOp: "eq",
      filterValue: "pro",
      moreFilters: [{ property: "region", op: "eq", value: "eu" }],
      identityKind: "anonymous",
      sourceId: "0197f0f2-0000-7000-8000-000000000000",
    }),
  );
});

test("a query the page cannot run is reported, not applied", () => {
  expect(explorable(queryToSpec({ measure: "count", group_by: "bogus" }))).toBe(false);
  expect(explorable(queryToSpec({ measure: "count", group_by: "property:bad key" }))).toBe(false);
  expect(explorable(queryToSpec({ measure: "count", source_id: "nope" }))).toBe(false);
  expect(
    explorable(
      queryToSpec({
        measure: "count",
        filters: [
          { property: "a", op: "eq", value: 1 },
          { property: "b", op: "gt", value: "text" },
        ],
      }),
    ),
  ).toBe(false);
  expect(explorable(queryToSpec({ measure: "max", property: "seconds" }))).toBe(true);
});

test("a rejected write reads as the API's message and hint", () => {
  const limited = Object.assign(new Error("Too many dashboard writes; slow down"), {
    status: 429,
    payload: {
      code: "rate_limited",
      errors: [
        {
          path: "",
          message: "Too many dashboard writes for this project",
          hint: "Retry after 12 s",
        },
      ],
    },
  });
  expect(viewErrorMessage(limited, "x")).toBe(
    "Too many dashboard writes for this project. Retry after 12 s",
  );
  expect(viewErrorMessage(new Error("Offline"), "x")).toBe("Offline");
  expect(viewErrorMessage("nope", "Could not save")).toBe("Could not save");
});

test("a view slug in the URL is bounded to what the API generates", () => {
  expect(validViewSlug("pro-plan-signups")).toBe(true);
  expect(validViewSlug("view-2")).toBe(true);
  expect(validViewSlug("")).toBe(false);
  expect(validViewSlug("../x")).toBe(false);
  expect(validViewSlug("Has Space")).toBe(false);
  expect(validViewSlug(3)).toBe(false);
});

test("log filters survive a round trip through a log view query", () => {
  const stored: LogViewDocument = {
    version: 1,
    kind: "logs",
    name: "Checkout",
    description: "kept",
    window: "6h",
    query: {
      min_level: "warn",
      service: "checkout",
      environment: "production",
      source_id: "src_1",
      search: "timeout",
      filters: [
        { attribute: "status", value: 500 },
        { attribute: "region", value: "tokyo" },
        { attribute: "cached", value: false },
      ],
    },
  };
  const applied = queryToLogs(stored.query, stored.window);
  expect(applied).toEqual({
    logq: "timeout",
    minLevel: "warn",
    service: "checkout",
    environment: "production",
    logSource: "src_1",
    logWindow: "6h",
    attribute: "status",
    attributeValue: "500",
    attributeType: "number",
    moreFilters: [
      { attribute: "region", value: "tokyo" },
      { attribute: "cached", value: false },
    ],
  });
  expect(logsRunnable(applied)).toBe(true);
  expect(logsToQuery(applied)).toEqual(stored.query);
  expect(currentLogView(stored, applied)).toEqual(stored);
});

test("an exact level and a bare view read back unchanged", () => {
  expect(queryToLogs({ level: "error" })).toEqual({ level: "error", logWindow: "1h" });
  expect(logsToQuery({ level: "error" })).toEqual({ level: "error" });
  expect(logsToQuery({})).toEqual({});
  // The opened view carries the default window; saving it keeps the stored document as it was.
  const bare: LogViewDocument = { version: 1, kind: "logs", name: "All", query: {} };
  expect(currentLogView(bare, queryToLogs(bare.query, bare.window))).toEqual(bare);
  const explicit: LogViewDocument = { ...bare, window: "1h" };
  expect(currentLogView(explicit, queryToLogs(explicit.query, explicit.window))).toEqual(explicit);
  // A window chosen on the page is saved.
  expect(currentLogView(bare, { logWindow: "24h" })).toEqual({ ...bare, window: "24h" });
});

test("typed attribute filters keep their types and only page-less fields are dropped", () => {
  const applied = queryToLogs({ filters: [{ attribute: "code", value: "42" }] });
  expect(applied).toMatchObject({ attributeValue: "42", attributeType: "string" });
  expect(logsToQuery(applied).filters).toEqual([{ attribute: "code", value: "42" }]);
  expect(
    logsToQuery({ logq: "x", trace: "abc", logBefore: { timestamp: 1, log_id: "a" } }),
  ).toEqual({ search: "x" });
});

test("a view the Logs page cannot run is not runnable", () => {
  expect(logsRunnable(queryToLogs({ level: "bogus" } as never))).toBe(false);
  expect(logsRunnable(queryToLogs({ level: "error", min_level: "warn" }))).toBe(false);
});

test("log search validates a minimum level, a pinned source, more filters and a view", () => {
  expect(
    validateLogsSearch({
      minLevel: "error",
      logSource: "src_1",
      view: "checkout",
      moreFilters: [{ attribute: "a", value: 1 }],
    }),
  ).toMatchObject({ minLevel: "error", logSource: "src_1", view: "checkout" });
  for (const value of [
    { minLevel: "loud" },
    { level: "error", minLevel: "warn" },
    { view: "Not A Slug" },
    { moreFilters: [{ attribute: "a", value: { x: 1 } }] },
    { moreFilters: Array.from({ length: 8 }, () => ({ attribute: "a", value: 1 })) },
  ])
    expect(validateLogsSearch(value)).toEqual({ invalidLogs: true });
});

test("an empty-string first filter survives a round trip through the Events page", () => {
  const query: EventViewQuery = {
    measure: "count",
    filters: [
      { property: "referrer", op: "eq", value: "" },
      { property: "path", op: "ne", value: "" },
    ],
  };
  expect(queryToSpec(query).filterValue).toBe('""');
  expect(specToQuery(queryToSpec(query))).toEqual(query);
});

test("a view's state compares equal after a URL round trip, whatever the key order", () => {
  const spec = queryToSpec({
    event: "signup",
    measure: "max",
    property: "seats",
    identity_kind: "anonymous",
    filters: [{ property: "plan", op: "eq", value: "pro" }],
  });
  const shuffled = Object.fromEntries(Object.entries(spec).reverse()) as ExploreSpec;
  const url = validateExploreSearch({ query: JSON.parse(JSON.stringify(shuffled)) }).query;
  expect(url && eventViewState(url)).toBe(eventViewState(spec));
  expect(eventViewState({ ...spec, event: "page_view" })).not.toBe(eventViewState(spec));
  // The client name is not part of a view, so it is not part of its state.
  expect(eventViewState({ ...spec, source: "browser" })).toBe(eventViewState(spec));

  const logs = queryToLogs({ level: "error", filters: [{ attribute: "status", value: 500 }] });
  expect(logViewState(validateLogsSearch({ ...logs }))).toBe(logViewState(logs));
  // A view that names no window opens on the default one.
  expect(logViewState({ ...logs, logWindow: undefined })).toBe(logViewState(logs));
  expect(logViewState({ ...logs, logWindow: "6h" })).not.toBe(logViewState(logs));
});

test("a trace ID or a selected range makes the Logs page differ from its view", () => {
  const logs = queryToLogs({ level: "error" });
  expect(logPageState(logs)).toBe(logViewState(logs));
  const narrowed = [
    { ...logs, trace: "a".repeat(32) },
    { ...logs, logFrom: "2026-11-14T10:00:00.000Z", logTo: "2026-11-14T10:05:00.000Z" },
  ];
  for (const search of narrowed) {
    expect(logViewState(search)).toBe(logViewState(logs));
    expect(logPageState(search)).not.toBe(logViewState(logs));
    // So a stored version that changed is held back, not applied over the narrowing.
    expect(
      viewSync({
        appliedAt: "a",
        applied: logViewState(logs),
        page: logPageState(search),
        stored: { at: "b", state: logViewState(queryToLogs({ level: "warn" })) },
      }),
    ).toBe("changed");
  }
});

test("a newer view version applies in place only when the page shows what it applied", () => {
  const stored = (at: string, state: string) => ({ at, state });
  const at = "2026-11-14T10:00:00.123456+00:00";
  const later = "2026-11-14T10:05:00+00:00";
  // The page applied this version.
  expect(viewSync({ appliedAt: at, applied: "a", page: "b", stored: stored(at, "a") })).toBe(
    "current",
  );
  // Nothing changed here: the newer query applies in place.
  expect(viewSync({ appliedAt: at, applied: "a", page: "a", stored: stored(later, "b") })).toBe(
    "apply",
  );
  // The page already shows the newer query, or the query did not change (a rename).
  expect(viewSync({ appliedAt: at, page: "b", stored: stored(later, "b") })).toBe("bump");
  expect(viewSync({ appliedAt: at, applied: "a", page: "c", stored: stored(later, "a") })).toBe(
    "bump",
  );
  // Changes on both sides, or a page that cannot tell (after a reload): the reader chooses.
  expect(viewSync({ appliedAt: at, applied: "a", page: "c", stored: stored(later, "b") })).toBe(
    "changed",
  );
  expect(viewSync({ appliedAt: at, page: "a", stored: stored(later, "b") })).toBe("changed");
});

test("the applied state is remembered per view and version", () => {
  rememberApplied("p:events:plans", "2026-11-14T10:00:00Z", "a");
  expect(appliedState("p:events:plans", "2026-11-14T10:00:00Z")).toBe("a");
  expect(appliedState("p:events:plans", "2026-11-14T10:05:00Z")).toBeUndefined();
  expect(appliedState("p:logs:plans", "2026-11-14T10:00:00Z")).toBeUndefined();
});

test("search accepts the applied view version and refuses anything else", () => {
  const at = "2026-11-14T10:00:00.123456789+00:00";
  expect(validateExploreSearch({ view: "plans", viewAt: at }).viewAt).toBe(at);
  expect(validateExploreSearch({ view: "plans", viewAt: "yesterday" }).invalidQuery).toBe(true);
  expect(validateLogsSearch({ view: "errors", viewAt: at }).viewAt).toBe(at);
  expect(validateLogsSearch({ view: "errors", viewAt: 1 }).invalidLogs).toBe(true);
});
