import { createFileRoute } from "@tanstack/react-router";
import { getAuth } from "../server/auth/auth";

// Better Auth's endpoints: sign-up, sign-in, sessions and everything its plugins add.
const handle = async ({ request }: { request: Request }) => (await getAuth()).handler(request);

export const Route = createFileRoute("/api/auth/$")({
  server: { handlers: { GET: handle, POST: handle } },
});
