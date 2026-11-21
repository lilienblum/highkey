import { createFileRoute, redirect } from "@tanstack/react-router";
import { ACCOUNT_SETTINGS } from "@/lib/auth-routes";

// Old bookmarks open ordinary account settings without carrying over report filters.
export const Route = createFileRoute("/admin")({
  beforeLoad: () => {
    throw redirect({ to: ACCOUNT_SETTINGS, replace: true });
  },
});
