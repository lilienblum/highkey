import { expect, test } from "bun:test";
import { workspaceTarget, workspaceView } from "../apps/dashboard/src/lib/workspace-route";

test("views match whole path segments, so view names are also valid project slugs", () => {
  expect(workspaceView("/acme/dashboards/events")).toBe("/events");
  expect(workspaceView("/acme/dashboards/logs")).toBe("/logs");
  expect(workspaceView("/acme/dashboards/settings")).toBe("/settings");
  expect(workspaceView("/acme/dashboards")).toBe("/");
  expect(workspaceView("/acme/dashboards/")).toBe("/");
  expect(workspaceView("/acme/orbit/dashboards/x")).toBe("/dashboards");
  expect(workspaceView("/acme/dashboards/dashboards/checkout")).toBe("/dashboards");
  expect(workspaceView("/acme/events")).toBe("/");
  expect(workspaceView("/acme/logs")).toBe("/");
  expect(workspaceView("/acme/settings")).toBe("/");
  expect(workspaceView("/acme/orbit/events")).toBe("/events");
  expect(workspaceView("/acme/orbit/dashboards")).toBe("/");
  expect(workspaceView("/acme/orbit/dashboards/x/y")).toBe("/");
});

test("bare paths keep the saved project's views", () => {
  expect(workspaceView("/")).toBe("/");
  expect(workspaceView("/events")).toBe("/events");
  expect(workspaceView("/logs")).toBe("/logs");
  expect(workspaceView("/settings")).toBe("/settings");
  expect(workspaceView("/acme")).toBe("/");
  expect(workspaceView("/dashboards/x")).toBe("/");
});

test("project targets name the organization; a dashboard needs its slug", () => {
  expect(workspaceTarget("acme", "/dashboards", "orbit", "checkout")).toEqual({
    to: "/$orgSlug/$projectSlug/dashboards/$dashboardSlug",
    params: { orgSlug: "acme", projectSlug: "orbit", dashboardSlug: "checkout" },
  });
  expect(workspaceTarget("acme", "/dashboards", "orbit")).toEqual({
    to: "/$orgSlug/$projectSlug",
    params: { orgSlug: "acme", projectSlug: "orbit" },
  });
  expect(workspaceTarget("acme", "/dashboards")).toEqual({ to: "/" });
  expect(workspaceTarget("acme", "/logs", "orbit", "checkout")).toEqual({
    to: "/$orgSlug/$projectSlug/logs",
    params: { orgSlug: "acme", projectSlug: "orbit" },
  });
  // Without an organization (signed out, or none yet) there is no project page to go to.
  expect(workspaceTarget(undefined, "/events", "orbit")).toEqual({ to: "/events" });
});
