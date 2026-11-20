import { createFileRoute } from "@tanstack/react-router";
import { AuthError, AuthFrame, AuthNotice } from "@/components/auth/auth-frame";
import { SubmitButton, useAuthForm } from "@/components/auth/auth-fields";
import { Button } from "@/components/ui/button";
import { authPost, follow, signedOAuthQuery } from "@/lib/auth-client";

// An agent's authorization stops here after sign-in: the person picks the organization the
// connection is for. The choice becomes the session's organization, then the flow continues.
export const Route = createFileRoute("/select-organization")({
  head: () => ({ meta: [{ title: "Choose an organization · Highkey" }] }),
  component: SelectOrganization,
});

const ROLE: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer: the agent can only read",
};

function SelectOrganization() {
  const { viewer } = Route.useRouteContext();
  const inFlow = typeof window !== "undefined" && Boolean(signedOAuthQuery(window.location.search));
  const form = useAuthForm(async (data) => {
    const organizationId = String(data.get("organization") ?? "");
    const active = await authPost("/organization/set-active", { organizationId });
    if (!active.ok) return active.error;
    const next = await authPost("/oauth2/continue", { postLogin: true });
    if (!next.ok) return next.error;
    follow(next.data, "/");
  });
  if (!viewer) return null;
  if (!inFlow)
    return (
      <AuthFrame title="Nothing to authorize">
        <AuthNotice>
          <p>This page is part of connecting an agent. Start from your agent’s connect step.</p>
        </AuthNotice>
        <Button
          size="lg"
          variant="outline"
          nativeButton={false}
          role="link"
          render={<a href="/" />}
        >
          Open Highkey
        </Button>
      </AuthFrame>
    );
  if (viewer.organizations.length === 0)
    return (
      <AuthFrame title="No organization yet">
        <AuthNotice>
          <p>You aren’t in an organization, so there is nothing to connect an agent to.</p>
        </AuthNotice>
      </AuthFrame>
    );
  const chosen = viewer.activeOrganizationId ?? viewer.organizations[0]?.id;
  return (
    <AuthFrame
      title="Connect an agent"
      lead="Choose the organization this agent works in. It sees only that organization’s projects."
    >
      <form className="auth-form" method="post" onSubmit={form.onSubmit}>
        <AuthError>{form.error}</AuthError>
        <fieldset className="auth-choices">
          <legend className="sr-only">Organization</legend>
          {viewer.organizations.map((org) => (
            <label key={org.id} className="auth-choice">
              <input
                type="radio"
                name="organization"
                value={org.id}
                defaultChecked={org.id === chosen}
                required
              />
              <span className="auth-choice-title">{org.name}</span>
              <span className="auth-choice-detail">{ROLE[org.role] ?? org.role}</span>
            </label>
          ))}
        </fieldset>
        <SubmitButton pending={form.pending}>Continue</SubmitButton>
      </form>
    </AuthFrame>
  );
}
