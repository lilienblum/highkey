import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AuthError, AuthFrame, AuthNotice } from "@/components/auth/auth-frame";
import { useHydrated } from "@/components/auth/auth-fields";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { authPost } from "@/lib/auth-client";
import { getInvitationDetails, type InvitationDetails } from "@/server/viewer";

// The page an invitation links to: who invited you, to which organization, as what. A new person
// creates their account from here; someone with an account signs in and accepts.
export const Route = createFileRoute("/join/$invitationId")({
  loader: ({ params }) => getInvitationDetails({ data: params.invitationId }),
  head: () => ({ meta: [{ title: "Join an organization · Highkey" }] }),
  component: Join,
});

const ROLE: Record<string, string> = {
  owner: "Owner: everything, including deleting the organization",
  admin: "Admin: people, projects, keys and settings",
  member: "Member: dashboards, views, sources and keys; reads everything",
  viewer: "Viewer: reads everything, changes nothing",
};

function Facts({ invitation }: { invitation: InvitationDetails }) {
  return (
    <dl className="auth-facts">
      <dt>From</dt>
      <dd>
        {invitation.inviter.name} ({invitation.inviter.email})
      </dd>
      <dt>For</dt>
      <dd>{invitation.email}</dd>
      <dt>Role</dt>
      <dd>{ROLE[invitation.role] ?? invitation.role}</dd>
    </dl>
  );
}

function Join() {
  const invitation = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  const [pending, setPending] = useState<"accept" | "decline" | "switch" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Actions wait for hydration: a click before it would do nothing.
  const hydrated = useHydrated();
  if (!invitation)
    return (
      <AuthFrame title="This invitation doesn’t exist">
        <AuthNotice>
          <p>Check the link, or ask whoever invited you to send it again.</p>
        </AuthNotice>
      </AuthFrame>
    );
  if (invitation.status !== "pending") {
    const why = {
      accepted: "This invitation was already accepted.",
      rejected: "This invitation was declined.",
      canceled: "This invitation was withdrawn.",
      expired: "This invitation has expired; invitations work for 7 days.",
    }[invitation.status];
    return (
      <AuthFrame title={`Join ${invitation.organization}`}>
        <AuthNotice>
          <p>
            {why} Ask {invitation.inviter.name} ({invitation.inviter.email}) for a new one.
          </p>
        </AuthNotice>
        {viewer ? (
          <Button
            size="lg"
            variant="outline"
            nativeButton={false}
            role="link"
            render={<a href="/" />}
          >
            Open Highkey
          </Button>
        ) : null}
      </AuthFrame>
    );
  }
  const here = `/join/${invitation.id}`;
  const title = `Join ${invitation.organization}`;
  const lead = (
    <>
      {invitation.inviter.name} invited you to <strong>{invitation.organization}</strong> on
      Highkey.
    </>
  );
  if (!viewer)
    return (
      <AuthFrame
        title={title}
        lead={lead}
        footer={
          <>
            Already have an account?{" "}
            <a href={`/sign-in?redirect=${encodeURIComponent(here)}`}>Sign in to accept</a>
          </>
        }
      >
        <Facts invitation={invitation} />
        <Button
          size="lg"
          className="auth-submit"
          nativeButton={false}
          role="link"
          render={
            <a
              href={`/sign-up?email=${encodeURIComponent(invitation.email)}&redirect=${encodeURIComponent(here)}`}
            />
          }
        >
          Create your account
        </Button>
      </AuthFrame>
    );
  const mine = viewer.user.email.toLowerCase() === invitation.email.toLowerCase();
  const answer = async (choice: "accept" | "decline") => {
    setPending(choice);
    setError(null);
    const result = await authPost<{ member?: { organizationId?: string } }>(
      choice === "accept" ? "/organization/accept-invitation" : "/organization/reject-invitation",
      { invitationId: invitation.id },
    );
    if (!result.ok) {
      setError(result.error);
      setPending(null);
      return;
    }
    const organizationId = result.data?.member?.organizationId;
    if (choice === "accept" && organizationId)
      await authPost("/organization/set-active", { organizationId });
    window.location.assign("/");
  };
  const switchAccount = async () => {
    setPending("switch");
    await authPost("/sign-out");
    window.location.assign(`/sign-in?redirect=${encodeURIComponent(here)}`);
  };
  if (!mine)
    return (
      <AuthFrame title={title} lead={lead}>
        <AuthNotice>
          <p>
            This invitation is for <strong>{invitation.email}</strong>, and you’re signed in as{" "}
            <strong>{viewer.user.email}</strong>. Sign in with the invited address to accept it.
          </p>
        </AuthNotice>
        <Button
          size="lg"
          className="auth-submit"
          disabled={pending !== null || !hydrated}
          onClick={switchAccount}
        >
          {pending === "switch" ? <Spinner aria-hidden="true" /> : null}
          Switch account
        </Button>
      </AuthFrame>
    );
  return (
    <AuthFrame title={title} lead={lead}>
      <Facts invitation={invitation} />
      <AuthError>{error}</AuthError>
      <div className="auth-actions">
        <Button
          size="lg"
          variant="outline"
          disabled={pending !== null || !hydrated}
          onClick={() => answer("decline")}
        >
          Decline
        </Button>
        <Button size="lg" disabled={pending !== null || !hydrated} onClick={() => answer("accept")}>
          {pending === "accept" ? <Spinner aria-hidden="true" /> : null}
          Accept
        </Button>
      </div>
    </AuthFrame>
  );
}
