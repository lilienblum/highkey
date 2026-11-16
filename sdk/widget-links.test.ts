import { expect, test } from "bun:test";
import { eventsLink, logsLink } from "../apps/dashboard/src/lib/widget-links";

const source = { id: "0198f0c4-4b8e-7c1d-9a52-1f2e3d4c5b6a", slug: "web" };
const product = { sources: [{ ...source, name: "Web", icon: null }] } as never;
const span = { from: "2026-11-01T00:00:00.000Z", to: "2026-11-08T00:00:00.000Z" };

test("Open in Events keeps the event, every filter, identity kind and pinned source", () => {
  const link = eventsLink(
    {
      signal: "events",
      event: "signup",
      identity_kind: "anonymous",
      source_id: source.id,
      filters: [
        { property: "plan", op: "eq", value: "pro" },
        { property: "region", op: "ne", value: "eu" },
        { property: "seats", op: "gte", value: 2 },
      ],
    },
    span,
    product,
  );
  expect(link).toMatchObject({ source: "all", from: span.from, to: span.to, view: undefined });
  expect(link?.query).toMatchObject({
    event: "signup",
    identityKind: "anonymous",
    sourceId: source.id,
    filterProperty: "plan",
    filterOp: "eq",
    filterValue: "pro",
    moreFilters: [
      { property: "region", op: "ne", value: "eu" },
      { property: "seats", op: "gte", value: 2 },
    ],
  });
  // The dashboard's own source stays the workspace source.
  expect(eventsLink({ signal: "events" }, span, product, source.id)?.source).toBe("web");
});

test("Open in Events is offered only for a query Events can show", () => {
  expect(eventsLink({ signal: "events", group_by: "bucket" }, span, product)).toBeUndefined();
  expect(
    eventsLink(
      { signal: "events", filters: [{ property: "plan", op: "contains", value: "pro" }] },
      span,
      product,
    ),
  ).toBeUndefined();
});

test("Open in Logs keeps the severity floor, attributes and pinned source", () => {
  const link = logsLink(
    {
      signal: "logs",
      min_level: "error",
      service: "checkout",
      environment: "production",
      search: "timeout",
      source_id: source.id,
      filters: [
        { attribute: "status", value: 500 },
        { attribute: "region", value: "tokyo" },
      ],
    },
    span,
    product,
  );
  expect(link).toMatchObject({
    source: "all",
    minLevel: "error",
    service: "checkout",
    environment: "production",
    logq: "timeout",
    logSource: source.id,
    attribute: "status",
    attributeValue: "500",
    attributeType: "number",
    moreFilters: [{ attribute: "region", value: "tokyo" }],
    logWindow: undefined,
    logFrom: span.from,
    logTo: span.to,
  });
  expect(link?.level).toBeUndefined();
});

test("Open in Logs opens the newest 31 days and skips queries Logs cannot express", () => {
  const long = { from: "2026-01-01T00:00:00.000Z", to: "2026-11-08T00:00:00.000Z" };
  expect(logsLink({ signal: "logs", level: "error" }, long, product)).toMatchObject({
    level: "error",
    logFrom: "2026-10-08T00:00:00.000Z",
    logTo: long.to,
  });
  expect(
    logsLink({ signal: "logs", filters: [{ attribute: "user", value: null }] }, span, product),
  ).toBeUndefined();
  expect(logsLink({ signal: "logs", level: "loud" }, span, product)).toBeUndefined();
});

test("filters the Events and Logs pages cannot express withhold the link", () => {
  for (const filter of [
    { property: "plan", op: "in", value: ["pro", "team"] },
    { property: "title", op: "contains", value: "checkout" },
    { property: "plan", op: "exists" },
  ])
    expect(eventsLink({ signal: "events", filters: [filter] }, span, product)).toBeUndefined();
  for (const filter of [
    { attribute: "region", op: "in", value: ["eu", "us"] },
    { attribute: "route", op: "contains", value: "checkout" },
    { attribute: "region", op: "not_exists" },
    { attribute: "region", op: "ne", value: "eu" },
  ])
    expect(logsLink({ signal: "logs", filters: [filter] }, span, product)).toBeUndefined();
  expect(
    logsLink(
      { signal: "logs", filters: [{ attribute: "region", op: "eq", value: "eu" }] },
      span,
      product,
    ),
  ).toBeDefined();
});
