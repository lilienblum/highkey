import { createFileRoute } from "@tanstack/react-router";
import { ApiKeys } from "@/components/settings/api-keys";

export const Route = createFileRoute("/organizations/settings/keys")({ component: ApiKeys });
