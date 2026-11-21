import { useState } from "react";
import { ErrorState } from "@/components/shared";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageLoading } from "../loading";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api";
import {
  formatDate,
  oversees,
  OrganizationSettingsHeader,
  useOrganizationRole,
} from "./settings-nav";
import { useLoaded } from "./use-loaded";

interface Connection {
  id: string;
  client: { id: string; name: string | null };
  user: { email: string };
  access: "read" | "write";
  created_at: string;
  last_used_at: string;
}

export function Agents() {
  const role = useOrganizationRole();
  const connections = useLoaded((signal) =>
    api<Connection[]>("/connections", "GET", undefined, signal),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const revoke = async (connection: Connection) => {
    setBusy(connection.id);
    setError(null);
    try {
      await api(`/connections/${connection.id}`, "DELETE");
      connections.reload();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const address = typeof window === "undefined" ? "/mcp" : `${window.location.origin}/mcp`;
  return (
    <>
      <OrganizationSettingsHeader />
      <div className="settings-stack">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <Card>
          <CardHeader>
            <CardTitle>{oversees(role) ? "Everyone’s connections" : "Your connections"}</CardTitle>
            <CardDescription>
              Connect an agent to <code>{address}</code>; it opens Highkey for you to sign in and
              choose its access.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {connections.error ? (
              <ErrorState message={connections.error} retry={connections.reload} />
            ) : !connections.data ? (
              <PageLoading label="Loading connected agents" />
            ) : connections.data.length === 0 ? (
              <p className="settings-muted">No agents are connected.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent</TableHead>
                    <TableHead>Access</TableHead>
                    {oversees(role) ? <TableHead>Connected by</TableHead> : null}
                    <TableHead>Connected</TableHead>
                    <TableHead>Last used</TableHead>
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {connections.data.map((connection) => (
                    <TableRow key={connection.id}>
                      <TableCell>{connection.client.name ?? connection.client.id}</TableCell>
                      <TableCell>
                        {connection.access === "write" ? "Read and write" : "Read only"}
                      </TableCell>
                      {oversees(role) ? <TableCell>{connection.user.email}</TableCell> : null}
                      <TableCell>{formatDate(connection.created_at)}</TableCell>
                      <TableCell>{formatDate(connection.last_used_at)}</TableCell>
                      <TableCell>
                        <div className="settings-row-actions">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy !== null}
                            aria-label={`Revoke ${connection.client.name ?? "agent"}`}
                            onClick={() => void revoke(connection)}
                          >
                            Revoke
                          </Button>
                        </div>
                      </TableCell>
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
