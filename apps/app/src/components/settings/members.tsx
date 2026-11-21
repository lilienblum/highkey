import { HugeiconsIcon } from "@hugeicons/react";
import { UserAdd01Icon } from "@hugeicons/core-free-icons";
import { useRouteContext } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { PageHeader } from "@/components/app-shell";
import { ErrorState } from "@/components/shared";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ValueSelect } from "@/components/value-select";
import { authAction, authGet } from "@/lib/auth-client";
import {
  formatDate,
  oversees,
  ROLE_LABEL,
  SettingsNav,
  useOrganizationId,
  useOrganizationRole,
} from "./settings-nav";
import { useLoaded } from "./use-loaded";
import { MemberProjects } from "./project-access";

interface Member {
  id: string;
  role: string;
  userId: string;
  user: { name: string; email: string };
}
interface Invitation {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: string;
}
interface FullOrganization {
  id: string;
  name: string;
  members: Member[];
  invitations: Invitation[];
}

const ROLES = ["viewer", "member", "admin", "owner"] as const;

function joinLink(id: string) {
  return `${window.location.origin}/join/${id}`;
}

export function Members() {
  const { viewer } = useRouteContext({ from: "__root__" });
  const role = useOrganizationRole();
  const organizationId = useOrganizationId();
  const manage = oversees(role);
  const org = useLoaded((signal) =>
    authGet<FullOrganization>(
      `/organization/get-full-organization?organizationId=${encodeURIComponent(organizationId)}`,
      signal,
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, work: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await work();
      org.reload();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const roleOptions = ROLES.filter((r) => r !== "owner" || role === "owner").map(
    (r) => [r, ROLE_LABEL[r] as string] as const,
  );
  const pending = org.data?.invitations.filter((i) => i.status === "pending") ?? [];
  return (
    <>
      <SettingsNav />
      <PageHeader
        title="Members"
        description="Organization roles and the projects each member can open or edit."
      />
      <div className="settings-stack">
        {manage ? <InviteCard roleOptions={roleOptions} onInvited={org.reload} /> : null}
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <Card>
          <CardHeader>
            <CardTitle>People</CardTitle>
            <CardDescription>
              Owners and admins manage people and projects; members build dashboards and manage
              sources and keys; viewers only read.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {org.error ? (
              <ErrorState message={org.error} retry={org.reload} />
            ) : !org.data ? (
              <Skeleton className="h-24 w-full" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {org.data.members.map((member) => (
                    <TableRow key={member.id}>
                      <TableCell>{member.user.name}</TableCell>
                      <TableCell>{member.user.email}</TableCell>
                      <TableCell>
                        {manage &&
                        member.userId !== viewer?.user.id &&
                        (member.role !== "owner" || role === "owner") ? (
                          <ValueSelect
                            label={`Role of ${member.user.email}`}
                            value={member.role}
                            options={roleOptions}
                            disabled={busy !== null}
                            onValueChange={(next) =>
                              void run(`role:${member.id}`, () =>
                                authAction("/organization/update-member-role", {
                                  organizationId,
                                  memberId: member.id,
                                  role: next,
                                }),
                              )
                            }
                          />
                        ) : (
                          (ROLE_LABEL[member.role] ?? member.role)
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="settings-row-actions">
                          {manage && ["member", "viewer"].includes(member.role) && (
                            <MemberProjects member={member.id} email={member.user.email} />
                          )}
                          {manage &&
                          member.userId !== viewer?.user.id &&
                          (member.role !== "owner" || role === "owner") ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy !== null}
                              aria-label={`Remove ${member.user.email}`}
                              onClick={() =>
                                void run(`remove:${member.id}`, () =>
                                  authAction("/organization/remove-member", {
                                    organizationId,
                                    memberIdOrEmail: member.id,
                                  }),
                                )
                              }
                            >
                              Remove
                            </Button>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
        {pending.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Pending invitations</CardTitle>
              <CardDescription>Invitations work for 7 days.</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pending.map((invitation) => (
                    <TableRow key={invitation.id}>
                      <TableCell>{invitation.email}</TableCell>
                      <TableCell>{ROLE_LABEL[invitation.role] ?? invitation.role}</TableCell>
                      <TableCell>{formatDate(invitation.expiresAt)}</TableCell>
                      <TableCell>
                        <div className="settings-row-actions">
                          <CopyButton content={joinLink(invitation.id)} size="sm">
                            Copy link
                          </CopyButton>
                          {manage ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy !== null}
                              onClick={() =>
                                void run(`cancel:${invitation.id}`, () =>
                                  authAction("/organization/cancel-invitation", {
                                    invitationId: invitation.id,
                                  }),
                                )
                              }
                            >
                              Withdraw
                            </Button>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}

function InviteCard({
  roleOptions,
  onInvited,
}: {
  roleOptions: readonly (readonly [string, string])[];
  onInvited: () => void;
}) {
  const organizationId = useOrganizationId();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const invitation = await authAction<{ id: string; link?: string }>(
        "/organization/invite-member",
        { email: email.trim(), role, organizationId },
      );
      setLink({ email: email.trim(), url: invitation.link ?? joinLink(invitation.id) });
      setEmail("");
      onInvited();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Invite someone</CardTitle>
        <CardDescription>
          They get a link to join with this role. If this server sends email, it’s emailed too.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="invite-form" onSubmit={submit}>
          <Field>
            <FieldLabel htmlFor="invite-email">Email</FieldLabel>
            <Input
              id="invite-email"
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@example.com"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="invite-role">Role</FieldLabel>
            <ValueSelect
              id="invite-role"
              label="Role"
              value={role}
              options={roleOptions}
              onValueChange={setRole}
            />
          </Field>
          <Button type="submit" disabled={busy}>
            {busy ? (
              <Spinner data-icon="inline-start" aria-hidden="true" />
            ) : (
              <HugeiconsIcon
                icon={UserAdd01Icon}
                strokeWidth={2}
                aria-hidden="true"
                data-icon="inline-start"
              />
            )}
            Invite
          </Button>
        </form>
        {error ? (
          <Alert variant="destructive" className="mt-4">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {link ? (
          <div className="invite-link" role="status">
            <p className="settings-muted">
              Invited {link.email}. Send them this link if they didn’t get an email:
            </p>
            <div className="settings-secret">
              <code>{link.url}</code>
              <CopyButton content={link.url} size="sm" aria-label="Copy the invitation link" />
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
