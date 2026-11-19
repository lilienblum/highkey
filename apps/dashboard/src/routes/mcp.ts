import { createFileRoute } from "@tanstack/react-router";
import { serveApi } from "../server/api/serve";

// The address agents connect to, and the resource their OAuth tokens are bound to: the full MCP
// server at /api/mcp. Scheduled runs use the read-only /api/read/mcp with an API key.
const forward = ({ request }: { request: Request }) => {
  const url = new URL(request.url);
  url.pathname = "/api/mcp";
  return serveApi(new Request(url, request));
};

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
