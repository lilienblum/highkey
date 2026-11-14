import { expect, test } from "bun:test";
import {
  defaultSpec,
  validateExploreSearch,
  type ExploreSpec,
} from "../apps/dashboard/src/lib/explore-search";
import {
  explorable,
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
