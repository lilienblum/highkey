import { createFileRoute } from "@tanstack/react-router";
import { AuthError, AuthFrame } from "@/components/auth/auth-frame";
import { SubmitButton, TextField, useAuthForm } from "@/components/auth/auth-fields";
import { authPost } from "@/lib/auth-client";
import { createOrganization } from "@/lib/organizations";
import { getPendingInvitations } from "@/server/viewer";

// An account can wait here for a team invitation or choose to create its own organization.
export const Route = createFileRoute("/welcome")({
  loader: () => getPendingInvitations(),
  head: () => ({ meta: [{ title: "Choose an organization · Highkey" }] }),
  component: Welcome,
});

const ROLE: Record<string, string> = {
  owner: "an owner",
  admin: "an admin",
  member: "a member",
  viewer: "a viewer",
};

function Welcome() {
  const { viewer } = Route.useRouteContext();
  const invitations = Route.useLoaderData();
  const form = useAuthForm(async (data) => {
    const name = String(data.get("name") ?? "").trim();
    if (!name) return "Name your organization.";
    try {
      window.location.assign(`/${await createOrganization(name)}`);
      return null;
    } catch (failure) {
      return (failure as Error).message;
    }
  });
  if (!viewer) return null;
  const signOut = async () => {
    await authPost("/sign-out");
    window.location.assign("/sign-in");
  };
  const none = viewer.organizations.length === 0;
  return (
    <AuthFrame
      title={none ? "No organization yet" : "Choose an organization"}
      lead={
        <>
          Signed in as <strong>{viewer.user.email}</strong>.{" "}
          {invitations.length
            ? "Join an organization that invited you, or create your own."
            : none
              ? "Joining a team? Ask them to send you an invitation link for this email address. You can come back when you have it."
              : "Choose an organization below, or create a new one."}
        </>
      }
      footer={
        <>
          Not you?{" "}
          <button
            type="button"
            className="auth-link auth-text-button"
            onClick={() => void signOut()}
          >
            Sign out
          </button>
        </>
      }
    >
      {invitations.length || !none ? (
        <ul className="auth-places" aria-label="Organizations you can open">
          {invitations.map((invitation) => (
            <li key={invitation.id} className="auth-place">
              <span className="auth-choice-title">{invitation.organization}</span>
              <span className="auth-choice-detail">
                {invitation.inviter} invited you as {ROLE[invitation.role] ?? invitation.role}
              </span>
              <a
                className="auth-link auth-place-action"
                href={`/join/${invitation.id}`}
                aria-label={`Join ${invitation.organization}`}
              >
                Join
              </a>
            </li>
          ))}
          {viewer.organizations.map((org) => (
            <li key={org.id} className="auth-place">
              <span className="auth-choice-title">{org.name}</span>
              <span className="auth-choice-detail">You’re {ROLE[org.role] ?? org.role}</span>
              <a
                className="auth-link auth-place-action"
                href={`/${org.slug}`}
                aria-label={`Open ${org.name}`}
              >
                Open
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      <form className="auth-form" method="post" onSubmit={form.onSubmit}>
        <AuthError>{form.error}</AuthError>
        <TextField
          name="name"
          label="Organization name"
          autoComplete="organization"
          maxLength={100}
          required
        />
        <SubmitButton pending={form.pending}>Create organization</SubmitButton>
      </form>
    </AuthFrame>
  );
}
