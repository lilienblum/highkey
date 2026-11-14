import { useId, type ComponentProps, type ReactNode } from "react";
import { Skeleton as MeasuredSkeleton } from "skullet/react";
import { Skeleton } from "@/components/ui/skeleton";
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
}: {
  value: string;
  label: string;
  loading: boolean;
  detail?: ReactNode;
  /** Change against the previous period. Its line is reserved while loading so tiles keep their size. */
  growth?: Growth;
  /** The previous period often arrives after the value, so its line loads on its own. */
  growthLoading?: boolean;
}) {
  return (
    <div className="widget-measurement">
      <div className="widget-value">
        <MeasuredSkeleton loading={loading}>
          <span>{loading ? "12,345" : value}</span>
        </MeasuredSkeleton>
      </div>
      {growth && (
        <span className="widget-growth" data-outcome={growthLoading ? "none" : growth.outcome}>
          <MeasuredSkeleton loading={growthLoading}>
            <span>{growthLoading ? "+12% vs previous 30 days" : growth.text}</span>
          </MeasuredSkeleton>
        </span>
      )}
      <span className="widget-measure-label">{label}</span>
      {detail && <span className="widget-measure-detail">{detail}</span>}
    </div>
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
      <div className="widget-placeholder" role="status" aria-label={`Loading ${label}`}>
        <Skeleton className="h-full w-full" />
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
