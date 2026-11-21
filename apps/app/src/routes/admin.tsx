import { createFileRoute, notFound } from "@tanstack/react-router";
import { Admin } from "@/components/settings/admin";
import { managementSearch } from "@/lib/route-search";

// The server admin's page; for anyone else it does not exist.
export const Route = createFileRoute("/admin")({
  search: managementSearch,
  beforeLoad: ({ context }) => {
    if (!context.viewer?.user.serverAdmin) throw notFound();
  },
  head: () => ({ meta: [{ title: "Server · Highkey" }] }),
  component: Admin,
});
