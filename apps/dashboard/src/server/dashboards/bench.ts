// Benchmarks widgets before a dashboard is saved, so a widget that would burn ClickHouse's time
// is refused with an actionable error instead of being discovered on every page view.
//
// Each new or changed widget runs once through `runWidget` (so it passes the same gate,
// validation and deadline as a page view) over the last 7 days ending now, or the widget's own
// `range`. A bench is a real run: it reads, and writes nothing. It happens before the SQLite
// write, so no transaction is held open meanwhile. Ported from the Rust API's bench.rs.
import type { ApiContext } from "../api/context";
import { busyBench, DashboardError, invalid, tooSlow } from "./errors";
import { runWidget } from "./run";
import type { Widget } from "./spec";
import { type Issue, Limits, Report } from "./validate";

/** Longest a single widget may take while benchmarking (further capped by its `timeout_ms`). */
export const WIDGET_BUDGET_MS = 3_000;
/** Longest the benchmarks of one save may take in total. */
export const TOTAL_BUDGET_MS = 15_000;
/** A widget slower than this saves, with a warning. */
export const WARN_MS = 1_000;
/** The shortest `timeout_ms` a widget may carry, so the smallest budget that can be given. */
const MIN_BUDGET_MS = 1_000;

export const HINT =
  "This widget took over 3 s on the last 7 days of data. Narrow it with a widget range, filter by event, property or service, or shorten a funnel's window or a retention's periods.";
const EXHAUSTED =
  "The save's combined benchmark budget (15 s) ran out at this widget; save fewer or lighter widgets at once";

export interface Bench {
  /** `{ widget, elapsed_ms }` for each widget that ran. */
  timings: { widget: string; elapsed_ms: number }[];
  warnings: Issue[];
}

function report(path: string, message: string, hint: string): Report {
  const r = new Report();
  r.error(path, message, hint);
  return r;
}

/** The hint for a widget over budget: the plain 3 s text, otherwise what actually set the budget. */
export function slowHint(widget: Widget, budget: number, remaining: number): string {
  const own = widget.timeout_ms ?? Limits.DEFAULT_TIMEOUT_MS;
  if (budget >= WIDGET_BUDGET_MS) return HINT;
  if (budget === remaining && remaining < own)
    return "The save's combined benchmark budget (15 s) is nearly used up; save fewer or lighter widgets at once";
  return `This widget's own timeout is ${own / 1000} s. Raise \`timeout_ms\`, or narrow it with a widget range, filter by event, property or service, or shorten a funnel's window or a retention's periods.`;
}

/** The widget as compared between revisions: keys sorted, absent fields dropped. */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (typeof v !== "object" || v === null) return v;
    return Object.fromEntries(
      Object.entries(v)
        .filter(([, item]) => item !== null && item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, item]) => [k, sort(item)]),
    );
  };
  return JSON.stringify(sort(value));
}

/** Runs every widget that is not identical to the widget of the same id in `previous`. */
export async function benchWidgets(
  ctx: ApiContext,
  productId: string,
  widgets: Widget[],
  previous: Widget[] | null,
  totalBudgetMs = TOTAL_BUDGET_MS,
): Promise<Bench> {
  const bench: Bench = { timings: [], warnings: [] };
  const stored = new Map((previous ?? []).map((w) => [w.id, canonical(w)]));
  let spent = 0;
  for (const [n, widget] of widgets.entries()) {
    if (stored.get(widget.id) === canonical(widget)) continue;
    const path = `/widgets/${n}`;
    const remaining = Math.max(0, totalBudgetMs - spent);
    if (remaining < MIN_BUDGET_MS)
      throw tooSlow(
        report(
          path,
          `The save's combined benchmark budget (${TOTAL_BUDGET_MS / 1000} s) ran out before this widget`,
          EXHAUSTED,
        ),
      );
    const budget = Math.min(
      widget.timeout_ms ?? Limits.DEFAULT_TIMEOUT_MS,
      WIDGET_BUDGET_MS,
      remaining,
    );
    const to = new Date();
    let result: Awaited<ReturnType<typeof runWidget>>;
    try {
      result = await runWidget(ctx, productId, {
        widget: { ...widget, timeout_ms: budget },
        from: new Date(to.getTime() - 7 * 86_400_000).toISOString(),
        to: to.toISOString(),
      });
    } catch (error) {
      if (error instanceof DashboardError && error.body.code === "query_timeout") {
        // Waiting for a query slot is Piko's load, not the widget's cost.
        if (error.queued)
          throw busyBench(
            report(path, "Piko was busy running other queries", "Retry the save in a few seconds"),
          );
        throw tooSlow(
          report(
            path,
            `This widget did not finish within ${budget} ms`,
            slowHint(widget, budget, remaining),
          ),
        );
      }
      // The run's own refusal, pointed at the widget inside the document.
      if (error instanceof DashboardError && error.body.code === "invalid_document") {
        const r = new Report();
        for (const issue of (error.body.errors ?? []) as Issue[])
          r.error(`${path}${issue.path}`, issue.message, issue.hint);
        for (const issue of (error.body.warnings ?? []) as Issue[])
          r.warnings.push({ ...issue, path: `${path}${issue.path}` });
        throw invalid(r);
      }
      throw error;
    }
    const elapsed = result.elapsed_ms;
    spent += elapsed;
    if (elapsed > budget)
      throw tooSlow(
        report(
          path,
          `This widget took ${elapsed} ms, over its ${budget} ms benchmark budget`,
          slowHint(widget, budget, remaining),
        ),
      );
    // The run's own warnings (unknown event, clamped range) help the author too.
    for (const issue of result.warnings) {
      const at = `${path}${issue.path}`;
      if (!bench.warnings.some((w) => w.path === at)) bench.warnings.push({ ...issue, path: at });
    }
    if (elapsed > WARN_MS)
      bench.warnings.push({
        path,
        message: `This widget took ${elapsed} ms on the last 7 days of data`,
        hint: "Slow widgets make the dashboard slow to open.",
      });
    bench.timings.push({ widget: widget.id, elapsed_ms: elapsed });
  }
  return bench;
}
