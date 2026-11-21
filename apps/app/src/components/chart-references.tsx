import { useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ruleX } from "@tanstack/charts";
import { decorative } from "@tanstack/charts/mark/decorative";
import { api, queryReadOnly } from "@/lib/api";
import { useReportQuery } from "@/lib/use-query";
import { bucketStart, type TimeBucket } from "@/lib/time-buckets";
import { useWorkspaceTarget } from "@/lib/workspace-route";
import { sourceParam } from "@/lib/workspace-search";
import type { ChartReference, listReferences } from "@/server/references";
import { useWorkspace } from "./app-shell";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Field, FieldLabel } from "./ui/field";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "./ui/card";
import { useOrganizationRole } from "./settings/settings-nav";
import type { AnalyticsRange } from "@/lib/date-range";

const load = (id: string, body: Record<string, unknown>, signal: AbortSignal) =>
  queryReadOnly<Awaited<ReturnType<typeof listReferences>>>(
    `/products/${id}/references/query`,
    body,
    signal,
  );
const empty: ChartReference[] = [];
export function useReferences(chartRange?: AnalyticsRange) {
  const { product, range, rangeScope, refreshKey } = useWorkspace();
  const dates = chartRange ?? range;
  return useReportQuery(
    load,
    "chart-references",
    product?.id,
    dates,
    refreshKey,
    dates.from === range.from && dates.to === range.to ? rangeScope : undefined,
  );
}
export function referenceMarks(
  rows: ChartReference[] = empty,
  bucket: TimeBucket,
  points: { time: number }[],
) {
  if (!rows.length || !points.length) return [];
  const present = new Set(points.map((p) => p.time));
  const times = [
    ...new Set(rows.map((r) => bucketStart(r.at, bucket)).filter((t) => present.has(t))),
  ];
  return [
    decorative(
      ruleX(times, {
        id: "references",
        stroke: "var(--data-secondary)",
        strokeWidth: 1,
        strokeDasharray: "3 4",
      }),
    ),
  ];
}
function ReferenceFields({ at, done }: { at: number; done: () => void }) {
  const { product } = useWorkspace(),
    client = useQueryClient();
  const [error, setError] = useState(""),
    [pending, setPending] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!product || pending) return;
    const f = new FormData(e.currentTarget);
    setPending(true);
    setError("");
    try {
      await api(`/products/${product.id}/references`, "POST", {
        title: f.get("title"),
        description: f.get("description"),
        at: new Date(f.get("at") + "Z").toISOString(),
      });
      await client.invalidateQueries({ queryKey: ["chart-references", product.id] });
      done();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <form className="grid gap-3" onSubmit={submit}>
      <Field>
        <FieldLabel>
          Title
          <Input name="title" placeholder="What changed?" required maxLength={120} />
        </FieldLabel>
      </Field>
      <Field>
        <FieldLabel>
          Description
          <Input name="description" placeholder="Optional context" maxLength={1000} />
        </FieldLabel>
      </Field>
      <Field>
        <FieldLabel>
          Date and time (UTC)
          <Input
            type="datetime-local"
            name="at"
            defaultValue={new Date(at).toISOString().slice(0, 19)}
            step={1}
            required
          />
        </FieldLabel>
      </Field>
      {error && <p role="alert">{error}</p>}
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save reference"}
      </Button>
    </form>
  );
}
export function ReferenceSettings() {
  const { range } = useWorkspace(),
    refs = useReferences(),
    role = useOrganizationRole();
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Chart references</CardTitle>
        <CardDescription>
          Notes on the project timeline. Deployments and first-seen CLI versions appear
          automatically.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {refs.error && <p role="alert">{refs.error}</p>}
        {refs.data?.rows.length ? (
          <ul className="mb-3 max-h-56 overflow-y-auto">
            {refs.data.rows.map((r) => (
              <li key={r.id} className="break-words">
                <time>{new Date(r.at).toISOString().slice(0, 10)}</time> · {r.title}
                {r.description && ` — ${r.description}`}
              </li>
            ))}
          </ul>
        ) : (
          !refs.loading && !refs.error && <p>No references in the selected period.</p>
        )}
        {refs.data?.truncated && <p>Showing the newest 250 references.</p>}
        {role && role !== "viewer" && (
          <Button variant="outline" onClick={() => setOpen(true)}>
            Add reference
          </Button>
        )}
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add reference</DialogTitle>
              <DialogDescription>Mark a change on the project's time charts.</DialogDescription>
            </DialogHeader>
            <ReferenceFields
              at={Math.min(Date.now(), Date.parse(range.to) - 1)}
              done={() => setOpen(false)}
            />
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
export function ChartPointActions({
  range,
  rows,
  close,
  zoom,
}: {
  range: AnalyticsRange;
  rows: ChartReference[];
  close: () => void;
  zoom?: () => void;
}) {
  const target = useWorkspaceTarget(),
    { product, sourceId } = useWorkspace(),
    role = useOrganizationRole();
  const [adding, setAdding] = useState(false);
  const notes = rows.filter((r) => r.at >= Date.parse(range.from) && r.at < Date.parse(range.to));
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v) close();
      }}
    >
      <DialogContent className="max-h-[85dvh] overflow-auto">
        <DialogHeader>
          <DialogTitle>{adding ? "Add reference" : "Chart point"}</DialogTitle>
          <DialogDescription>
            {range.from.slice(0, 16).replace("T", " ")} – {range.to.slice(0, 16).replace("T", " ")}{" "}
            UTC
          </DialogDescription>
        </DialogHeader>
        {adding ? (
          <ReferenceFields at={Date.parse(range.from)} done={close} />
        ) : (
          <>
            {!!notes.length && (
              <ul className="grid gap-2">
                {notes.map((r) => (
                  <li key={r.id}>
                    <strong>{r.title}</strong>
                    {r.description && <p>{r.description}</p>}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Link
                {...target("/people", product?.slug)}
                search={{ ...range, source: sourceParam(product?.sources, sourceId) }}
                onClick={close}
              >
                View users
              </Link>
              {role && role !== "viewer" && (
                <Button variant="outline" onClick={() => setAdding(true)}>
                  Add reference
                </Button>
              )}
              {zoom && <Button onClick={zoom}>Zoom to bucket</Button>}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
