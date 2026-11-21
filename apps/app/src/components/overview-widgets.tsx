import { useId, type ComponentProps, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { Growth } from "@/lib/growth";

export function OverviewWidget({
  title,
  controls,
  children,
  footer,
  className = "",
  error,
  retry,
  ...props
}: {
  title: string;
  controls?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  error?: string;
  retry: () => void;
} & Omit<ComponentProps<"section">, "title" | "children" | "className">) {
  const id = useId();
  return (
    <section {...props} className={`overview-widget ${className}`} aria-labelledby={id}>
      <header className="widget-header">
        <h2 id={id}>{title}</h2>
        {controls}
      </header>
      <div className="widget-body">{children}</div>
      <footer className="widget-footer">
        {error ? (
          <div className="widget-error" role="alert">
            <span className="widget-error-message">{error}</span>
            <Button variant="ghost" size="sm" onClick={retry}>
              Retry
            </Button>
          </div>
        ) : (
          footer
        )}
      </footer>
    </section>
  );
}

export function WidgetValue({
  value,
  label,
  loading,
  detail,
  growth,
  growthLoading = loading,
  compactGrowth,
}: {
  value: string;
  label: string;
  loading: boolean;
  detail?: ReactNode;
  /** Change against the previous period. Its line is reserved while loading so tiles keep their size. */
  growth?: Growth;
  /** The previous period often arrives after the value, so its line loads on its own. */
  growthLoading?: boolean;
  /** One short line for small tiles; the full sentence moves to the title and screen readers. */
  compactGrowth?: boolean;
}) {
  return (
    <div className="widget-measurement">
      <div className="widget-value" aria-busy={loading}>
        {loading ? null : value}
      </div>
      {growth && <GrowthLine growth={growth} loading={growthLoading} compact={compactGrowth} />}
      <span className="widget-measure-label">{label}</span>
      {detail && <span className="widget-measure-detail">{detail}</span>}
    </div>
  );
}

/** The change against the previous period; it keeps its line while loading so nothing shifts. */
export function GrowthLine({
  growth,
  loading,
  compact,
}: {
  growth: Growth;
  loading: boolean;
  compact?: boolean;
}) {
  const none = growth.outcome === "none";
  return (
    <span
      className="widget-growth"
      data-outcome={loading ? "none" : growth.outcome}
      data-compact={compact || undefined}
      title={loading ? undefined : none ? "No previous data" : compact ? growth.text : undefined}
    >
      {loading ? null : none ? (
        <>
          <span aria-hidden="true">{growth.text}</span>
          <span className="sr-only">no previous data</span>
        </>
      ) : compact ? (
        <>
          <span aria-hidden="true">{growth.short}</span>
          <span className="sr-only">{growth.text}</span>
        </>
      ) : (
        growth.text
      )}
    </span>
  );
}

export function WidgetContent({
  loading,
  empty,
  label,
  children,
}: {
  loading: boolean;
  empty?: string;
  label: string;
  children: ReactNode;
}) {
  if (loading)
    return (
      <div className="min-h-0 w-full flex-1" role="status" aria-label={`Loading ${label}`}>
        <span className="sr-only">Loading {label}…</span>
      </div>
    );
  if (empty)
    return (
      <div className="widget-empty" role="status">
        <p>{empty}</p>
      </div>
    );
  return children;
}
