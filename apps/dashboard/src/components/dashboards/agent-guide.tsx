import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Copy01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Product } from "@/lib/api";

const docsUrl = "https://github.com/lilienblum/piko#readme";

export type GuideDashboard = { slug: string; name: string; revision: number };
export type GuideView = { slug: string; name: string; kind: "events" | "logs" };
export type GuideMode = "create" | "edit" | "view";

const noopSubscribe = () => () => {};
/** The page's origin; a placeholder on the server so hydration agrees. */
function useOrigin(): string {
  return useSyncExternalStore(
    noopSubscribe,
    () => window.location.origin,
    () => "https://your-piko-host",
  );
}

export function claudeCommand(origin: string) {
  return `claude mcp add --transport http piko ${origin}/api/mcp`;
}
export function codexConfig(origin: string) {
  return `[mcp_servers.piko]\nurl = "${origin}/api/mcp"`;
}
export function askPrompt(
  mode: GuideMode,
  project: string,
  dashboard?: GuideDashboard,
  view?: GuideView,
) {
  if (mode === "view" && view)
    return `In Piko project "${project}", change the saved ${view.kind} view "${view.slug}": … . Read it with get_view (kind ${view.kind}), then save the change with save_view, keeping its name unless asked.`;
  if (mode === "edit" && dashboard)
    return `In Piko project "${project}", update dashboard "${dashboard.slug}" (revision ${dashboard.revision}): … . Read it with get_dashboard, preview changes with run_widget, and save with base_revision ${dashboard.revision}.`;
  return `In Piko project "${project}", create a dashboard named "…" that shows … . Use describe_project first, preview widgets with run_widget, then save_dashboard.`;
}

const viewExamples = {
  events: [
    {
      title: "Narrow to a plan",
      note: "Filter",
      prompt: "Filter this view to events where the plan property is pro, grouped by path.",
    },
    {
      title: "Switch the measure",
      note: "Measure",
      prompt: "Change this view to the 95th percentile of duration_ms, grouped by command.",
    },
  ],
  logs: [
    {
      title: "Narrow to errors",
      note: "Filter",
      prompt: "Show only error logs from the checkout service in this view.",
    },
    {
      title: "Widen the window",
      note: "Window",
      prompt: "Show warnings and errors from the last 24 hours in this view.",
    },
  ],
};

const examples = [
  {
    title: "Checkout error rate",
    note: "Events and logs",
    prompt:
      "Add a line widget, Checkout error rate, that divides error logs from the checkout service by checkout_request events, as a percent.",
  },
  {
    title: "Weekly churn by cohort",
    note: "SQL",
    prompt:
      "Add a SQL widget showing weekly churn by signup cohort, with one series per cohort, over the last 90 days.",
  },
  {
    title: "Slowest routes",
    note: "SQL table",
    prompt:
      "Add a SQL table widget listing the 10 slowest routes by p95 duration, with their request counts.",
  },
];

/** A prompt with its “…” placeholders marked, so they read as blanks to fill in. */
function Marked({ text }: { text: string }) {
  const parts = text.split("…");
  return parts.map((part, index) => (
    // The text is static, so a part's position is its identity.
    // biome-ignore lint/suspicious/noArrayIndexKey: parts never reorder
    <Fragment key={index}>
      {part}
      {index < parts.length - 1 && <span className="agent-guide-blank">…</span>}
    </Fragment>
  ));
}

/**
 * The guide's copy controls share one polite live region that stays mounted, so "Copied" is
 * announced without moving focus or shifting the layout.
 */
function useCopy() {
  const [status, setStatus] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy(text: string) {
    let message = "Copied";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      message = "Could not copy. Allow clipboard access and try again.";
    }
    clearTimeout(timer.current);
    setStatus(message);
    timer.current = setTimeout(() => setStatus(""), 2500);
  }
  return { status, copy };
}

function CopyBlock({
  label,
  text,
  children,
  onCopy,
}: {
  label: string;
  text: string;
  children?: ReactNode;
  onCopy: (text: string) => void;
}) {
  return (
    <div className="agent-guide-block">
      <pre className="agent-guide-text">
        <code>{children ?? text}</code>
      </pre>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label={label}
        onClick={() => onCopy(text)}
      >
        <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} aria-hidden="true" />
      </Button>
    </div>
  );
}

/** The three sections: connect an agent, a prompt to ask it, and examples. */
export function AgentGuide({
  mode,
  project,
  dashboard,
  view,
  headingLevel = 3,
}: {
  mode: GuideMode;
  project: Product;
  dashboard?: GuideDashboard;
  view?: GuideView;
  headingLevel?: 2 | 3;
}) {
  const origin = useOrigin();
  const { status, copy } = useCopy();
  const ids = useId();
  const Heading = `h${headingLevel}` as "h2" | "h3";
  const prompt = askPrompt(mode, project.slug, dashboard, view);
  const shown = mode === "view" ? viewExamples[view?.kind ?? "events"] : examples;
  return (
    <div className="agent-guide">
      <section aria-labelledby={`${ids}-connect`}>
        <Heading id={`${ids}-connect`} className="agent-guide-heading">
          Connect your agent
        </Heading>
        <p className="agent-guide-label">Claude Code</p>
        <CopyBlock
          label="Copy Claude Code command"
          text={claudeCommand(origin)}
          onCopy={(text) => void copy(text)}
        />
        <p className="agent-guide-label">Codex, in ~/.codex/config.toml</p>
        <CopyBlock
          label="Copy Codex config"
          text={codexConfig(origin)}
          onCopy={(text) => void copy(text)}
        />
        <p className="agent-guide-note">
          Behind Cloudflare Access, add the CF-Access-Client-Id and CF-Access-Client-Secret headers.{" "}
          <a href={docsUrl} target="_blank" rel="noreferrer">
            See the docs
          </a>
          .
        </p>
      </section>
      <section aria-labelledby={`${ids}-ask`}>
        <Heading id={`${ids}-ask`} className="agent-guide-heading">
          Ask it
        </Heading>
        <CopyBlock label="Copy prompt" text={prompt} onCopy={(text) => void copy(text)}>
          <Marked text={prompt} />
        </CopyBlock>
      </section>
      <section aria-labelledby={`${ids}-examples`}>
        <Heading id={`${ids}-examples`} className="agent-guide-heading">
          Examples
        </Heading>
        {shown.map((example) => (
          <div key={example.title}>
            <p className="agent-guide-label">
              {example.title} <span>{example.note}</span>
            </p>
            <CopyBlock
              label={`Copy example: ${example.title}`}
              text={example.prompt}
              onCopy={(text) => void copy(text)}
            />
          </div>
        ))}
      </section>
      <p role="status" aria-live="polite" className="agent-guide-status">
        {status}
      </p>
    </div>
  );
}

/** The guide as a dialog, for creating a dashboard or changing the open dashboard or view. */
export function AgentGuideDialog({
  open,
  onOpenChange,
  mode,
  project,
  dashboard,
  view,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: GuideMode;
  project: Product;
  dashboard?: GuideDashboard;
  view?: GuideView;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="agent-guide-dialog">
        <DialogHeader>
          <DialogTitle>
            {mode === "view" ? "Edit view" : mode === "edit" ? "Edit dashboard" : "New dashboard"}
          </DialogTitle>
          <DialogDescription>
            {mode === "view"
              ? `Saved views are changed by your agent over MCP. Ask it to update ${view?.name ?? "this view"}.`
              : mode === "edit"
                ? `Piko dashboards are changed by your agent over MCP. Ask it to update ${dashboard?.name ?? "this dashboard"}.`
                : "Piko dashboards are created by your agent over MCP. Connect it, then describe what you want to see."}
          </DialogDescription>
        </DialogHeader>
        <AgentGuide mode={mode} project={project} dashboard={dashboard} view={view} />
      </DialogContent>
    </Dialog>
  );
}
