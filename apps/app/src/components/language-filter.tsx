import { useState } from "react";
import type { ReportDialogProps } from "./overview-actions";
import { useNavigate } from "@tanstack/react-router";
import { api } from "@/lib/api";
import type { DatePeriod } from "@/lib/date-range";
import type { languageFilter } from "@/server/language-filter";
import { useWorkspace } from "./app-shell";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
export function LanguageFilter({ open, onOpenChange, finalFocus }: ReportDialogProps) {
  const { product, range, sourceId } = useWorkspace(),
    navigate = useNavigate({ from: "/$orgSlug/$projectSlug/" }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!busy) {
          onOpenChange(v);
          setError("");
        }
      }}
    >
      <DialogContent finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>Describe a filter</DialogTitle>
          <DialogDescription>
            Try “last 7 days, mobile only”. Other phrases use the configured model; only your phrase
            is sent.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!product || busy) return;
            const text = new FormData(e.currentTarget).get("text");
            setBusy(true);
            setError("");
            try {
              const r = await api<Awaited<ReturnType<typeof languageFilter>>>(
                `/products/${product.id}/language-filter`,
                "POST",
                { text, ...range, source_id: sourceId },
              );
              const days = r.period.endsWith("d") ? (parseInt(r.period) as 7 | 30 | 90) : undefined;
              await navigate({
                search: (s) => ({
                  ...s,
                  ...(r.filter ? { filter: r.filter } : {}),
                  ...(r.period === "keep"
                    ? {}
                    : {
                        from: undefined,
                        to: undefined,
                        snapshot: undefined,
                        days,
                        period: days ? undefined : (r.period as DatePeriod),
                      }),
                }),
                resetScroll: false,
              });
              onOpenChange(false);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Filter phrase
            <Input name="text" required maxLength={320} />
          </label>
          {error && <p role="alert">{error}</p>}
          <Button type="submit" disabled={busy}>
            {busy ? "Checking values…" : "Apply filter"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
