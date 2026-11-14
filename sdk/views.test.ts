import { expect, test } from "bun:test";
import { defaultSpec, type ExploreSpec } from "../apps/dashboard/src/lib/explore-search";
import { queryToSpec, specToQuery, validViewSlug } from "../apps/dashboard/src/lib/views";

const spec = (patch: Partial<ExploreSpec>): ExploreSpec => ({ ...defaultSpec, ...patch });

test("the default Explore spec saves as a plain grouped count and reads back unchanged", () => {
  const query = specToQuery(defaultSpec);
  expect(query).toEqual({ measure: "count", group_by: "name" });
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

test("a query written by an agent opens with the Events page's defaults filled in", () => {
  expect(queryToSpec({ event: "signup", measure: "count" })).toEqual(
    spec({ event: "signup", group: "name" }),
  );
  const opened = queryToSpec({
    event: "signup",
    measure: "avg",
    property: "seconds",
    group_by: "property:plan",
    // Fields the Events page cannot show are left out rather than guessed at.
    source_id: "0197f0f2-0000-7000-8000-000000000000",
    identity_kind: "anonymous",
    filters: [
      { property: "plan", op: "eq", value: "pro" },
      { property: "region", op: "eq", value: "eu" },
    ],
  });
  expect(opened).toEqual(
    spec({
      event: "signup",
      measure: "avg",
      property: "seconds",
      group: "property:plan",
      filterProperty: "plan",
      filterOp: "eq",
      filterValue: "pro",
    }),
  );
});

test("a view slug in the URL is bounded to what the API generates", () => {
  expect(validViewSlug("pro-plan-signups")).toBe(true);
  expect(validViewSlug("view-2")).toBe(true);
  expect(validViewSlug("")).toBe(false);
  expect(validViewSlug("../x")).toBe(false);
  expect(validViewSlug("Has Space")).toBe(false);
  expect(validViewSlug(3)).toBe(false);
});
