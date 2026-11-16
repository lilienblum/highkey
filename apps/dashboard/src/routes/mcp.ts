import { createFileRoute } from "@tanstack/react-router";
import { serveApi } from "../server/api/serve";

// The short address agents connect to: the full MCP server at /api/mcp. The read-only server
// keeps /api/read/mcp so Access can scope its token.
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
