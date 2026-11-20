import { createFileRoute, redirect } from "@tanstack/react-router";

/** Explore became Events; old links keep working with their search. */
export const Route = createFileRoute("/$orgSlug/$projectSlug/explore")({
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: "/$orgSlug/$projectSlug/events",
      params,
      search,
      replace: true,
    });
  },
});
