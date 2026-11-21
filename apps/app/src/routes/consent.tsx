import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AuthError, AuthFrame, AuthNotice } from "@/components/auth/auth-frame";
import { useHydrated } from "@/components/auth/auth-fields";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { authPost, follow, signedOAuthQuery } from "@/lib/auth-client";
import { getAgentName } from "@/server/viewer";

// The agent's consent: who is asking, for which organization, and with what access. Viewers
// can grant only read access.
export const Route = createFileRoute("/consent")({
  validateSearch: (search: Record<string, unknown>) => ({
    client_id: typeof search.client_id === "string" ? search.client_id : undefined,
    scope: typeof search.scope === "string" ? search.scope : undefined,
  }),
  loaderDeps: ({ search }) => ({ client: search.client_id }),
  loader: ({ deps }) => (deps.client ? getAgentName({ data: deps.client }) : null),
  head: () => ({ meta: [{ title: "Connect an agent · Highkey" }] }),
  component: Consent,
});

function host(clientId: string): string {
  try {
    return new URL(clientId).host;
  } catch {
    return clientId;
  }
}

function Consent() {
  const name = Route.useLoaderData();
  const { client_id: clientId, scope } = Route.useSearch();
  const { viewer } = Route.useRouteContext();
  const [pending, setPending] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Actions wait for hydration: a click before it would do nothing.
  const hydrated = useHydrated();
  const requested = (scope ?? "").split(" ").filter(Boolean);
  const org = viewer?.organizations.find((o) => o.id === viewer.activeOrganizationId);
  const canWrite = requested.includes("mcp:write") && org !== undefined && org.role !== "viewer";
  const [access, setAccess] = useState<"read" | "write">("read");
  const inFlow = typeof window !== "undefined" && Boolean(signedOAuthQuery(window.location.search));
  if (!viewer) return null;
  if (!clientId || !inFlow || !org)
    return (
      <AuthFrame title="Nothing to authorize">
        <AuthNotice>
          <p>This page is part of connecting an agent. Start from your agent’s connect step.</p>
        </AuthNotice>
      </AuthFrame>
    );
  const agent = name ?? host(clientId);
  const decide = async (accept: boolean) => {
    setPending(accept ? "allow" : "deny");
    setError(null);
    const granted = requested.filter((s) => s !== "mcp:write" || (canWrite && access === "write"));
    const result = await authPost(
      "/oauth2/consent",
      accept ? { accept, scope: granted.join(" ") } : { accept },
    );
    if (!result.ok) {
      setError(result.error);
      setPending(null);
      return;
    }
    follow(result.data, "/");
  };
  return (
    <AuthFrame
      title={`Connect ${agent}`}
      lead={
        <>
          <strong>{agent}</strong> wants to use Highkey’s tools in <strong>{org.name}</strong>, as
          you.
        </>
      }
      footer="You can revoke it any time in Organization settings → Agents."
    >
      <dl className="auth-facts">
        <dt>Agent</dt>
        <dd>
          {agent} ({host(clientId)})
        </dd>
        <dt>Organization</dt>
        <dd>{org.name}</dd>
      </dl>
      <fieldset className="auth-choices">
        <legend className="auth-legend">Access</legend>
        <label className="auth-choice">
          <input
            type="radio"
            name="access"
            value="read"
            checked={access === "read"}
            onChange={() => setAccess("read")}
          />
          <span className="auth-choice-title">Read only</span>
          <span className="auth-choice-detail">
            Describe projects, run queries, read dashboards and logs.
          </span>
        </label>
        <label className="auth-choice">
          <input
            type="radio"
            name="access"
            value="write"
            checked={access === "write"}
            disabled={!canWrite}
            onChange={() => setAccess("write")}
          />
          <span className="auth-choice-title">Read and write</span>
          <span className="auth-choice-detail">
            {org.role === "viewer"
              ? "Viewers can grant read access only."
              : requested.includes("mcp:write")
                ? "Also save dashboards and views, and manage projects, sources and keys as your role allows."
                : "This agent asked for read access only."}
          </span>
        </label>
      </fieldset>
      <AuthError>{error}</AuthError>
      <div className="auth-actions">
        <Button
          size="lg"
          variant="outline"
          disabled={pending !== null || !hydrated}
          onClick={() => decide(false)}
        >
          Deny
        </Button>
        <Button size="lg" disabled={pending !== null || !hydrated} onClick={() => decide(true)}>
          {pending === "allow" ? <Spinner aria-hidden="true" /> : null}
          Allow
        </Button>
      </div>
    </AuthFrame>
  );
}
