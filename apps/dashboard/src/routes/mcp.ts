import { createFileRoute } from "@tanstack/react-router";
import { proxyApi } from "../server/api-gateway";

// The short address agents connect to. It is the API's full MCP server at /api/mcp, which stays
// the API's own path; the read-only server keeps /api/read/mcp so Access can scope its token.
const forward = ({ request }: { request: Request }) => proxyApi(request, "/api/mcp");

export const Route = createFileRoute("/mcp")({
  server: {
    handlers: {
      GET: forward,
      POST: forward,
      DELETE: forward,
      OPTIONS: forward,
    },
  },
});
