import { createFileRoute } from "@tanstack/react-router";
import { isIngestPath, proxyIngest } from "../server/api-gateway";
import { serveApi } from "../server/api/serve";

// Ingestion belongs to the ingest app; everything else under /api is served here.
const serve = ({ request }: { request: Request }) =>
  isIngestPath(new URL(request.url).pathname) ? proxyIngest(request) : serveApi(request);

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      GET: serve,
      HEAD: serve,
      POST: serve,
      PUT: serve,
      PATCH: serve,
      DELETE: serve,
      OPTIONS: serve,
    },
  },
});
