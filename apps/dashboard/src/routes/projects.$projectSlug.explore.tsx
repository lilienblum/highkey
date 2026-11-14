import { createFileRoute, redirect } from "@tanstack/react-router";

/** Explore became Events; old links keep working with their search. */
export const Route = createFileRoute("/projects/$projectSlug/explore")({
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: "/projects/$projectSlug/events",
      params,
      search,
      replace: true,
    });
  },
});
