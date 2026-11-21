import { useState } from "react";
import { useWorkspace } from "@/components/app-shell";
import { ErrorState } from "@/components/shared";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageLoading } from "../loading";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatDate } from "./settings-nav";
import { useLoaded } from "./use-loaded";

interface DeletedProject {
  id: string;
  name: string;
  slug: string;
  deleted_at: string;
  restorable_until: string;
}

/** Projects deleted in the last 7 days, which an admin or owner can bring back, keys and all. */
export function DeletedProjects({ organizationSlug }: { organizationSlug: string }) {
  const { reload } = useWorkspace();
  const deleted = useLoaded((signal) =>
    api<DeletedProject[]>("/deleted-products", "GET", undefined, signal),
  );
  const [restoring, setRestoring] = useState<string | null>(null);
  const [restored, setRestored] = useState<DeletedProject | null>(null);
  const [error, setError] = useState<string | null>(null);
  const restore = async (project: DeletedProject) => {
    setRestoring(project.id);
    setError(null);
    setRestored(null);
    try {
      await api(`/deleted-products/${project.id}/restore`, "POST");
      setRestored(project);
      deleted.reload();
      // The project picker lists it again; a failed refresh only waits for the next load.
      void reload().catch(() => undefined);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setRestoring(null);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Deleted projects</CardTitle>
        <CardDescription>
          Restore a project within 7 days of deleting it. After that, its events and logs are wiped.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {restored ? (
          <p className="settings-muted mb-4" role="status">
            Restored {restored.name}. <a href={`/${organizationSlug}/${restored.slug}`}>Open it</a>
          </p>
        ) : null}
        {error ? (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {deleted.error ? (
          <ErrorState message={deleted.error} retry={deleted.reload} />
        ) : !deleted.data ? (
          <PageLoading label="Loading deleted projects" />
        ) : deleted.data.length === 0 ? (
          <p className="settings-muted">No deleted projects.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Project</TableHead>
                <TableHead>Deleted</TableHead>
                <TableHead>Restorable until</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deleted.data.map((project) => (
                <TableRow key={project.id}>
                  <TableCell>{project.name}</TableCell>
                  <TableCell>{formatDate(project.deleted_at)}</TableCell>
                  <TableCell>{formatDate(project.restorable_until)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={restoring !== null}
                      aria-busy={restoring === project.id}
                      aria-label={`Restore ${project.name}`}
                      onClick={() => void restore(project)}
                    >
                      {restoring === project.id ? (
                        <Spinner data-icon="inline-start" aria-hidden="true" />
                      ) : null}
                      Restore
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
