import { createFileRoute } from "@tanstack/react-router";
import { serveLlms } from "../server/llms";

export const Route = createFileRoute("/llms.txt")({
  server: { handlers: { GET: ({ request }) => serveLlms(request, false) } },
});
