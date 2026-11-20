import { createFileRoute } from "@tanstack/react-router";
import { realtimeEnabled } from "../server/realtime";

export const Route = createFileRoute("/_highkey/runtime")({
  server: {
    handlers: {
      GET: () =>
        Response.json({ live: realtimeEnabled() }, { headers: { "Cache-Control": "no-store" } }),
    },
  },
});
