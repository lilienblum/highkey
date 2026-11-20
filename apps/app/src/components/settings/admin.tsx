import { useRouteContext } from "@tanstack/react-router";
import { useState } from "react";
import { PageHeader } from "@/components/app-shell";
import { ErrorState } from "@/components/shared";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatDate, SettingsNav } from "./settings-nav";
import { useLoaded } from "./use-loaded";

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  banned: boolean;
  two_factor: boolean;
  created_at: string;
}
interface Organization {
  id: string;
  name: string;
  slug: string;
  members: number;
  projects: number;
  created_at: string;
}

/** The server admin's page: everyone on this server, above every organization. */
export function Admin() {
  const { viewer } = useRouteContext({ from: "__root__" });
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const users = useLoaded((signal) =>
    api<User[]>(`/admin/users?search=${encodeURIComponent(query)}`, "GET", undefined, signal),
  );
  const organizations = useLoaded((signal) =>
    api<Organization[]>(
      `/admin/organizations?search=${encodeURIComponent(query)}`,
      "GET",
      undefined,
      signal,
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const act = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
      users.reload();
    } catch (failure) {
      setError((failure as Error).message);
    }
  };
  return (
    <>
      <SettingsNav />
      <PageHeader
        title="Server"
        description="Everyone with an account on this server, and their organizations."
      />
      <div className="settings-stack">
        <form
          className="admin-search"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(search.trim());
            users.reload();
            organizations.reload();
          }}
        >
          <Input
            type="search"
            aria-label="Search people and organizations"
            placeholder="Search by name or email"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {link ? (
          <Card>
            <CardHeader>
              <CardTitle>Reset link for {link.email}</CardTitle>
              <CardDescription>Hand it over yourself; it works once, for 24 hours.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="settings-secret" role="status">
                <code>{link.url}</code>
                <CopyButton content={link.url} size="sm" aria-label="Copy the reset link" />
              </div>
            </CardContent>
          </Card>
        ) : null}
        <Card>
          <CardHeader>
            <CardTitle>People</CardTitle>
          </CardHeader>
          <CardContent>
            {users.error ? (
              <ErrorState message={users.error} retry={users.reload} />
            ) : !users.data ? (
              <Skeleton className="h-24 w-full" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Joined</TableHead>
                    <TableHead>
                      <span className="sr-only">Status and actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.data.map((user) => (
                    <TableRow key={user.id}>
                      <TableCell>{user.name}</TableCell>
                      <TableCell>{user.email}</TableCell>
                      <TableCell>{formatDate(user.created_at)}</TableCell>
                      <TableCell>
                        <div className="settings-row-actions">
                          {user.role === "admin" ? (
                            <Badge variant="outline">Server admin</Badge>
                          ) : null}
                          {user.two_factor ? <Badge variant="outline">Two-factor</Badge> : null}
                          {user.banned ? <Badge variant="destructive">Banned</Badge> : null}
                          {user.id === viewer?.user.id ? null : (
                            <DropdownMenu>
                              <DropdownMenuTrigger
                                render={
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    aria-label={`Actions for ${user.email}`}
                                  />
                                }
                              >
                                Actions
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="min-w-52">
                                <DropdownMenuItem
                                  onClick={() =>
                                    void act(() =>
                                      api(
                                        `/admin/users/${user.id}/${user.banned ? "unban" : "ban"}`,
                                        "POST",
                                        {},
                                      ),
                                    )
                                  }
                                >
                                  {user.banned ? "Unban" : "Ban"}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() =>
                                    void act(() =>
                                      api(`/admin/users/${user.id}/revoke-sessions`, "POST", {}),
                                    )
                                  }
                                >
                                  Sign out everywhere
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() =>
                                    void act(async () => {
                                      const result = await api<{ link: string }>(
                                        `/admin/users/${user.id}/reset-link`,
                                        "POST",
                                        {},
                                      );
                                      setLink({ email: user.email, url: result.link });
                                    })
                                  }
                                >
                                  Password reset link
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  variant="destructive"
                                  onClick={() => {
                                    if (
                                      window.confirm(
                                        `Delete ${user.email}’s account? This cannot be undone.`,
                                      )
                                    )
                                      void act(() => api(`/admin/users/${user.id}`, "DELETE"));
                                  }}
                                >
                                  Delete account
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Organizations</CardTitle>
          </CardHeader>
          <CardContent>
            {organizations.error ? (
              <ErrorState message={organizations.error} retry={organizations.reload} />
            ) : !organizations.data ? (
              <Skeleton className="h-24 w-full" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Address</TableHead>
                    <TableHead>Members</TableHead>
                    <TableHead>Projects</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {organizations.data.map((org) => (
                    <TableRow key={org.id}>
                      <TableCell>{org.name}</TableCell>
                      <TableCell>
                        <code>/{org.slug}</code>
                      </TableCell>
                      <TableCell className="tabular-nums">{org.members}</TableCell>
                      <TableCell className="tabular-nums">{org.projects}</TableCell>
                      <TableCell>{formatDate(org.created_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
