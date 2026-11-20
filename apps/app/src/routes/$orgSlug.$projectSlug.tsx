import { createFileRoute, Outlet } from "@tanstack/react-router";
export const Route = createFileRoute("/$orgSlug/$projectSlug")({ component: Outlet });
