import { expect, test } from "bun:test";
import { workspaceTarget, workspaceView } from "../apps/dashboard/src/lib/workspace-route";

test("views match whole path segments, so view names are also valid project slugs", () => {
  expect(workspaceView("/projects/dashboards/explore")).toBe("/explore");
  expect(workspaceView("/projects/dashboards/logs")).toBe("/logs");
  expect(workspaceView("/projects/dashboards/settings")).toBe("/settings");
  expect(workspaceView("/projects/dashboards")).toBe("/");
  expect(workspaceView("/projects/dashboards/")).toBe("/");
  expect(workspaceView("/projects/orbit/dashboards/x")).toBe("/dashboards");
  expect(workspaceView("/projects/dashboards/dashboards/checkout")).toBe("/dashboards");
  expect(workspaceView("/projects/explore")).toBe("/");
  expect(workspaceView("/projects/logs")).toBe("/");
  expect(workspaceView("/projects/settings")).toBe("/");
  expect(workspaceView("/projects/orbit/explore")).toBe("/explore");
  expect(workspaceView("/projects/orbit/dashboards")).toBe("/");
  expect(workspaceView("/projects/orbit/dashboards/x/y")).toBe("/");
});

test("bare paths keep the saved project's views", () => {
  expect(workspaceView("/")).toBe("/");
  expect(workspaceView("/explore")).toBe("/explore");
  expect(workspaceView("/logs")).toBe("/logs");
  expect(workspaceView("/settings")).toBe("/settings");
  expect(workspaceView("/dashboards/x")).toBe("/");
});

test("a dashboard target needs its slug and otherwise falls back to Overview", () => {
  expect(workspaceTarget("/dashboards", "orbit", "checkout")).toEqual({
    to: "/projects/$projectSlug/dashboards/$dashboardSlug",
    params: { projectSlug: "orbit", dashboardSlug: "checkout" },
  });
  expect(workspaceTarget("/dashboards", "orbit")).toEqual({
    to: "/projects/$projectSlug",
    params: { projectSlug: "orbit" },
  });
  expect(workspaceTarget("/dashboards")).toEqual({ to: "/" });
  expect(workspaceTarget("/logs", "orbit", "checkout")).toEqual({
    to: "/projects/$projectSlug/logs",
    params: { projectSlug: "orbit" },
  });
});
