import { createFileRoute, redirect } from "@tanstack/react-router";

/** Explore became Events; old links keep working with their search. */
export const Route = createFileRoute("/explore")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/events", search, replace: true });
  },
});
