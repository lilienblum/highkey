import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { AuthError, AuthNotice } from "@/components/auth/auth-frame";
import { SubmitButton, TextField, useAuthForm } from "@/components/auth/auth-fields";
import { ConnectAgent } from "@/components/dashboards/agent-guide";
import { DitherField } from "@/components/dither-field";
import { type Integration, IntegrationTabs } from "@/components/integration-guide";
import { FirstEventNotice, WebsiteCheck } from "@/components/activation";
import { oversees } from "@/components/settings/settings-nav";
import { type SourceDraft, SourceFields } from "@/components/source-settings";
import { ProjectWebsites, parseWebsites } from "@/components/project-websites";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { api, type Product, type Source } from "@/lib/api";
import { authPost } from "@/lib/auth-client";

// Where an organization without projects starts, and where anyone can start another project.
export const Route = createFileRoute("/new")({
  head: () => ({ meta: [{ title: "Create a project · Highkey" }] }),
  component: NewProject,
});

const root = getRouteApi("__root__");

/** New projects keep events 365 days, as in the product; it changes in project settings. */
const RETENTION_DAYS = 365;

/** A dotted rule along the top edge: 2px dots on a 4px pitch, the workspace's seam. */
const SEAM = "border-t-2 [border-image:var(--rule-x)_2_0_0_/_2px_0_0]";
const LINK = "cursor-pointer text-primary underline-offset-3 hover:underline";
const HINT = "max-w-[64ch] text-xs leading-relaxed text-pretty text-muted-foreground";

type Created = { project: Product; source: Source; key: string };

function NewProject() {
  const { viewer } = Route.useRouteContext();
  const { initialProducts } = root.useLoaderData();
  const organization = viewer?.organizations.find((org) => org.id === viewer.activeOrganizationId);
  // What a failed attempt already made is kept, so trying again only does the rest.
  const project = useRef<Product | null>(null);
  const source = useRef<Source | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [sourceDraft, setSourceDraft] = useState<SourceDraft>({ name: "", icon: null });
  const form = useAuthForm(async (data) => {
    if (!organization) return "Choose an organization first.";
    const sourceName = sourceDraft.name.trim();
    if (!sourceName) return "Name the source.";
    try {
      project.current ??= await api<Product>("/products", "POST", {
        name: String(data.get("name") ?? "").trim(),
        website_urls: parseWebsites(String(data.get("websites") ?? "")),
        retention_days: RETENTION_DAYS,
      });
    } catch (failure) {
      return (failure as Error).message;
    }
    const made = project.current;
    try {
      source.current ??= await api<Source>(`/products/${made.id}/sources`, "POST", {
        name: sourceName,
        icon: sourceDraft.icon,
        visitor_mode: sourceDraft.visitor_mode,
      });
      const key = await api<{ key: string }>(`/products/${made.id}/keys`, "POST", {
        label: source.current.name,
        source_id: source.current.id,
      });
      setCreated({ project: made, source: source.current, key: key.key });
      return null;
    } catch (failure) {
      const missing = source.current ? "its key" : "its source";
      return `${made.name} was created, but ${missing} wasn’t: ${(failure as Error).message}`;
    }
  });
  if (!viewer || !organization) return null;
  const first = initialProducts.length === 0;
  const creates = oversees(organization.role);
  const signOut = async () => {
    await authPost("/sign-out");
    window.location.assign("/sign-in");
  };
  return (
    <div
      data-page="new-project"
      className="grid min-h-svh grid-cols-[minmax(0,1fr)] bg-background lg:grid-cols-[minmax(0,min(60%,52rem))_minmax(0,1fr)]"
    >
      <div
        className={`mx-auto grid min-h-svh w-full min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr_auto] px-6 sm:px-10 ${created ? "max-w-[50rem]" : "max-w-[42rem]"}`}
      >
        <header className="flex h-20 items-center justify-between gap-3">
          <a href="/" className="brand-link" aria-label="Highkey">
            <span className="brand">
              <img className="brand-mark" src="/favicon.svg?v=7" width="30" height="30" alt="" />
              <span className="brand-word">highkey</span>
            </span>
          </a>
          {creates && (
            <span className="text-xs tabular-nums text-muted-foreground">
              Step {created ? 2 : 1} of 2
            </span>
          )}
        </header>
        {created ? (
          <Connect organization={organization.slug} created={created} />
        ) : (
          <main className="flex min-w-0 flex-col gap-5 pt-4 pb-10 sm:pt-8">
            {creates ? (
              <>
                <h1 className="text-[34px] leading-[1.1] lg:text-[40px]">
                  {first ? "Create your first project" : "Create a project"}
                </h1>
                <Lead>Name your project and its first source. Next, you’ll connect your app.</Lead>
                <form className="auth-form" method="post" onSubmit={form.onSubmit}>
                  <AuthError>{form.error}</AuthError>
                  <TextField
                    name="name"
                    label="Project name"
                    className="max-w-[22rem]"
                    placeholder="e.g. Orbit"
                    autoComplete="off"
                    maxLength={80}
                    required
                  />
                  <div className="grid gap-1.5">
                    <details className="peer">
                      <summary className="w-fit cursor-pointer text-sm text-primary">
                        Add websites (optional)
                      </summary>
                      <div className="mt-3">
                        <ProjectWebsites id="new-project-websites" />
                      </div>
                    </details>
                    <p className={`${HINT} peer-open:hidden`}>
                      Any website with the source key can send events by default.
                    </p>
                  </div>
                  <div className={`mt-1 grid min-w-0 gap-4 pt-5 ${SEAM}`}>
                    <SourceFields
                      value={sourceDraft}
                      onChange={setSourceDraft}
                      label="Source"
                      hint="The website, app, or tool that sends events."
                    />
                  </div>
                  <SubmitButton pending={form.pending} compact>
                    Create project
                  </SubmitButton>
                </form>
              </>
            ) : (
              <>
                <h1 className="text-[34px] leading-[1.1] lg:text-[40px]">
                  {first ? "No projects yet" : "Create a project"}
                </h1>
                <Lead>
                  Only owners and admins create projects in{" "}
                  <strong className="font-semibold text-foreground">{organization.name}</strong>.
                </Lead>
                <AuthNotice>
                  <p>Ask an owner or admin to create one.</p>
                </AuthNotice>
              </>
            )}
          </main>
        )}
        <footer
          className={`flex min-h-16 items-center justify-between gap-3 text-[13px] text-muted-foreground ${SEAM}`}
        >
          <span className="flex min-w-0 items-baseline gap-2.5">
            <span>Organization:</span>
            <strong className="truncate font-semibold text-foreground">{organization.name}</strong>
            <a href="/welcome" className={`shrink-0 ${LINK}`}>
              Switch
            </a>
          </span>
          <button type="button" className={LINK} onClick={() => void signOut()}>
            Sign out
          </button>
        </footer>
      </div>
      <aside
        aria-labelledby="new-project-how"
        className="sticky top-0 hidden h-svh min-w-0 flex-col overflow-hidden border-l-2 bg-sidebar [border-image:var(--rule-y)_0_0_0_2_/_0_0_0_2px] lg:flex"
      >
        <div className="relative isolate min-h-40 flex-1">
          <DitherField profile="field" drift="always" />
        </div>
        <div className="px-[clamp(28px,4vw,56px)] pb-[clamp(32px,6vh,64px)]">
          <h2
            id="new-project-how"
            className="mb-5 font-pixel text-[22px] leading-tight font-normal text-heading"
          >
            From project to first event
          </h2>
          <ol className="grid gap-[18px]">
            <Step
              number={1}
              state={created ? "done" : "current"}
              title="Name the project and a source"
            >
              A project is one product; each source (a site, an app, a CLI) gets its own keys.
            </Step>
            <Step number={2} state={created ? "current" : "next"} title="Connect your app">
              Add the snippet for your source and watch for its first event.
            </Step>
          </ol>
        </div>
      </aside>
    </div>
  );
}

function Lead({ children }: { children: ReactNode }) {
  return (
    <p className="-mt-1 text-[13px] leading-relaxed text-pretty text-muted-foreground">
      {children}
    </p>
  );
}

/** A finished step steps back to the muted ink. */
function Step({
  number,
  state,
  title,
  children,
}: {
  number: number;
  state: "done" | "current" | "next";
  title: string;
  children: ReactNode;
}) {
  const done = state === "done";
  return (
    <li
      aria-current={state === "current" ? "step" : undefined}
      className="grid grid-cols-[28px_1fr] gap-x-3 gap-y-1"
    >
      <span
        aria-hidden="true"
        className={`row-span-2 font-pixel text-[22px] leading-none ${done ? "text-muted-foreground" : "text-data"}`}
      >
        {done ? <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="size-5" /> : number}
      </span>
      <strong
        className={`text-sm font-semibold ${done ? "text-muted-foreground" : "text-foreground"}`}
      >
        {title}
      </strong>
      <span className="max-w-[46ch] text-[13px] leading-relaxed text-pretty text-muted-foreground">
        {children}
      </span>
    </li>
  );
}

/** The second step: the new source's key in a snippet for the app, and the agent's MCP setup. */
function Connect({ organization, created }: { organization: string; created: Created }) {
  const { project, source, key } = created;
  const [integration, setIntegration] = useState<Integration>("browser");
  const [copyFailed, setCopyFailed] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  // The form is gone: focus moves to what replaced it.
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, []);
  const home = `/${organization}/${project.slug}`;
  return (
    <main className="flex w-full min-w-0 max-w-[720px] flex-col gap-6 pt-2 pb-16">
      <h1
        ref={heading}
        tabIndex={-1}
        className="text-[34px] leading-[1.1] outline-none lg:text-[40px]"
      >
        Connect {source.name}
      </h1>
      <Lead>
        <strong className="font-semibold text-foreground">{project.name}</strong> is ready. Choose
        the instructions for your app. The snippet already includes this source’s key.
      </Lead>
      <FirstEventNotice id={project.id} source={source} />
      <section aria-labelledby="new-project-app" className={`flex flex-col gap-3 pt-5 ${SEAM}`}>
        <h2
          id="new-project-app"
          className="font-pixel text-xl leading-snug font-normal text-heading"
        >
          Add Highkey to your app
        </h2>
        <details>
          <summary className="w-fit cursor-pointer text-sm text-primary">View source key</summary>
          <div className="my-2 flex items-center gap-2 rounded-md border bg-surface-inset px-3 py-2.5 font-mono text-[13px] [overflow-wrap:anywhere]">
            <code data-testid="ingestion-key" className="min-w-0 flex-1">
              {key}
            </code>
            <CopyButton variant="ghost" aria-label="Copy ingestion key" content={key} />
          </div>
          <p className={HINT}>
            Copy this key or the snippet before leaving. You can create another key in Settings.
          </p>
        </details>
        {copyFailed ? (
          <p className={HINT} role="alert">
            Clipboard unavailable. Select the snippet and copy it manually.
          </p>
        ) : null}
        <IntegrationTabs
          value={integration}
          onValueChange={setIntegration}
          ingestionKey={key}
          visitorMode={source.visitor_mode}
          onCopyError={() => setCopyFailed(true)}
        />
        {project.website_url && <WebsiteCheck id={project.id} />}
      </section>
      <details className={`pt-5 ${SEAM}`}>
        <summary>Connect an agent (optional)</summary>
        <p className={`my-3 ${HINT}`}>
          Ask Claude Code or Codex about {project.name}, or have it build dashboards and views.
        </p>
        <ConnectAgent />
      </details>
      <div className="flex flex-wrap items-center justify-between gap-4 pt-2">
        <a
          href={`${home}/settings?source=${encodeURIComponent(source.slug)}`}
          className={`text-[13px] ${LINK}`}
        >
          Project settings
        </a>
        <Button
          className="ms-auto max-w-full"
          nativeButton={false}
          role="link"
          render={<a href={home} />}
        >
          <span className="truncate">Open {project.name}</span>
        </Button>
      </div>
    </main>
  );
}
