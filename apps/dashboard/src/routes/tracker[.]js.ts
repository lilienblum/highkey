import { createFileRoute } from "@tanstack/react-router";
import { proxyIngest } from "../server/api-gateway";

// The ingest app serves the tracker, so it stays up through dashboard deploys. This forward is
// for setups whose edge sends everything to the dashboard.
export const Route = createFileRoute("/tracker.js")({
  server: { handlers: { GET: ({ request }) => proxyIngest(request) } },
});
