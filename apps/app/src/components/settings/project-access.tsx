import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspace } from "../app-shell";
import { api } from "@/lib/api";
import {
  Dialog,
  DialogHeader,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { ValueSelect } from "../value-select";
import { ErrorState } from "../shared";
type Scope = { mode: "all" | "selected"; projects: { id: string; access: "read" | "write" }[] };
export function MemberProjects({ member, email }: { member: string; email: string }) {
  const { products } = useWorkspace(),
    path = `/members/${member}/projects`;
  const [open, setOpen] = useState(false),
    [draft, setDraft] = useState<Scope>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const saved = useQuery({
    queryKey: ["member-projects", member],
    enabled: open,
    queryFn: ({ signal }) => api<Scope>(path, "GET", undefined, signal),
  });
  const current = draft ?? saved.data;
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!busy) {
          setOpen(v);
          setDraft(undefined);
          setError("");
        }
      }}
    >
      <DialogTrigger
        render={<Button variant="outline" size="sm" aria-label={`Projects for ${email}`} />}
      >
        Project access
      </DialogTrigger>
      <DialogContent className="max-h-[85dvh] overflow-auto">
        <DialogHeader>
          <DialogTitle>Project access</DialogTitle>
          <DialogDescription>
            Choose the projects {email} can access. Their organization role still limits what they
            can do.
          </DialogDescription>
        </DialogHeader>
        {saved.error && <ErrorState message={saved.error.message} />}
        {current && (
          <>
            <ValueSelect
              label="Project access mode"
              value={current.mode}
              options={[
                ["all", "All projects, including future projects"],
                ["selected", "Selected projects only"],
              ]}
              onValueChange={(v) =>
                setDraft({
                  mode: v as Scope["mode"],
                  projects: v === "all" ? [] : current.projects,
                })
              }
            />
            {current.mode === "selected" &&
              products.map((p) => (
                <label className="grid gap-1" key={p.id}>
                  {p.name}
                  <ValueSelect
                    label={`Access to ${p.name}`}
                    value={current.projects.find((v) => v.id === p.id)?.access ?? "none"}
                    options={[
                      ["none", "No access"],
                      ["read", "Read only"],
                      ["write", "Edit"],
                    ]}
                    onValueChange={(v) =>
                      setDraft({
                        ...current,
                        projects: [
                          ...current.projects.filter((s) => s.id !== p.id),
                          ...(v === "none" ? [] : [{ id: p.id, access: v as "read" | "write" }]),
                        ],
                      })
                    }
                  />
                </label>
              ))}
            <Button
              disabled={busy || !draft}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await api(path, "PUT", current);
                  await saved.refetch();
                  setOpen(false);
                  setDraft(undefined);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Save project access
            </Button>
          </>
        )}
        {error && <ErrorState message={error} />}
      </DialogContent>
    </Dialog>
  );
}
