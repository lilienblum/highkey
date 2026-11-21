import { createFileRoute } from "@tanstack/react-router";
import { Members } from "@/components/settings/members";

export const Route = createFileRoute("/organizations/settings/members")({ component: Members });
