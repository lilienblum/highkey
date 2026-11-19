import { createFileRoute } from "@tanstack/react-router";
import { getAuth } from "../server/auth/auth";

// OAuth discovery for agents, at the origin's root as MCP clients look for it: the protected
// resource metadata for /mcp and the authorization server metadata, both served by Better Auth.
const handle = async ({ request }: { request: Request }) => (await getAuth()).handler(request);

export const Route = createFileRoute("/.well-known/$")({
  server: { handlers: { GET: handle } },
});
