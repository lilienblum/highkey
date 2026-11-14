import { Fragment, useEffect, useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { CopyButton } from "@/components/ui/copy-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Product } from "@/lib/api";
import { readPreference, savePreference } from "@/lib/preferences";

const docsUrl = "https://github.com/lilienblum/piko/blob/master/docs/dashboards.md#ask-your-ai";

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
  return `claude mcp add --transport http piko ${origin}/mcp`;
}
export function codexConfig(origin: string) {
  return `[mcp_servers.piko]\nurl = "${origin}/mcp"`;
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

type Agent = "claude" | "codex";
const agentKey = "piko:agent";

/**
 * The agent tab the viewer last picked. It starts on Claude Code for the server render and
 * switches after hydration, so the markup agrees.
 */
function useAgent(): [Agent, (agent: Agent) => void] {
  const [agent, setAgent] = useState<Agent>("claude");
  useEffect(() => {
    if (readPreference(agentKey) === "codex") setAgent("codex");
  }, []);
  return [
    agent,
    (next) => {
      setAgent(next);
      savePreference(agentKey, next);
    },
  ];
}

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

function CopyBlock({
  label,
  text,
  children,
}: {
  label: string;
  text: string;
  children?: ReactNode;
}) {
  return (
    <div className="agent-guide-block">
      <pre className="agent-guide-text">
        <code>{children ?? text}</code>
      </pre>
      <CopyButton aria-label={label} content={text} />
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
  const [agent, setAgent] = useAgent();
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
        <Tabs
          value={agent}
          onValueChange={(value) => setAgent(value as Agent)}
          className="agent-guide-tabs"
        >
          <TabsList variant="line" aria-label="Agent">
            <TabsTrigger value="claude">Claude Code</TabsTrigger>
            <TabsTrigger value="codex">Codex</TabsTrigger>
          </TabsList>
          <TabsContent value="claude" className="agent-guide-panel">
            <p className="agent-guide-label">Run in your terminal</p>
            <CopyBlock label="Copy Claude Code command" text={claudeCommand(origin)} />
          </TabsContent>
          <TabsContent value="codex" className="agent-guide-panel">
            <p className="agent-guide-label">Add to ~/.codex/config.toml</p>
            <CopyBlock label="Copy Codex config" text={codexConfig(origin)} />
          </TabsContent>
        </Tabs>
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
        <CopyBlock label="Copy prompt" text={prompt}>
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
            <CopyBlock label={`Copy example: ${example.title}`} text={example.prompt} />
          </div>
        ))}
      </section>
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
