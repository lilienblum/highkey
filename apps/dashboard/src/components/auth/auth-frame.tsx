import type { ReactNode } from "react";
import { DitherField } from "@/components/dither-field";

/**
 * The account screens: the workspace sidebar's identity block standing on its own, with one task
 * below it. Whoever signs in meets the same mark, bloom and wordmark the sidebar greets them with.
 */
export function AuthFrame({
  title,
  lead,
  children,
  footer,
}: {
  title: string;
  lead?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="auth-screen">
      <section className="auth-panel" aria-labelledby="auth-title">
        <header className="auth-identity">
          <DitherField profile="band" />
          <a href="/" className="brand-link" aria-label="Highkey">
            <span className="brand">
              <img className="brand-mark" src="/favicon.svg?v=7" width="30" height="30" alt="" />
              <span className="brand-word">highkey</span>
            </span>
          </a>
        </header>
        <div className="auth-body">
          <h1 id="auth-title">{title}</h1>
          {lead ? <p className="auth-lead">{lead}</p> : null}
          {children}
        </div>
        {footer ? <footer className="auth-footer">{footer}</footer> : null}
      </section>
    </main>
  );
}

/** A refusal or failure, announced to screen readers when it appears. */
export function AuthError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p className="auth-error" role="alert">
      {children}
    </p>
  );
}

/** A finished step: what happened and what comes next. */
export function AuthNotice({ children }: { children: ReactNode }) {
  return (
    <div className="auth-notice" role="status">
      {children}
    </div>
  );
}
