import { createFileRoute, notFound } from "@tanstack/react-router";
import { Admin } from "@/components/settings/admin";

// The server admin's page; for anyone else it does not exist.
export const Route = createFileRoute("/admin")({
  beforeLoad: ({ context }) => {
    if (!context.viewer?.user.serverAdmin) throw notFound();
  },
  head: () => ({ meta: [{ title: "Server · Highkey" }] }),
  component: Admin,
});
