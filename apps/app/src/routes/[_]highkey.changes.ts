import { createFileRoute } from "@tanstack/react-router";
import { receiveChanges } from "../server/realtime";

export const Route = createFileRoute("/_highkey/changes")({
  server: { handlers: { POST: ({ request }) => receiveChanges(request) } },
});
