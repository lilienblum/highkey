import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { AuthError, AuthNotice } from "@/components/auth/auth-frame";
import { SubmitButton, TextField, useAuthForm } from "@/components/auth/auth-fields";
import { ConnectAgent } from "@/components/dashboards/agent-guide";
import { DitherField } from "@/components/dither-field";
import { type Integration, IntegrationTabs } from "@/components/integration-guide";
import { FirstEventNotice, WebsiteCheck } from "@/components/activation";
import { oversees } from "@/components/settings/settings-nav";
import { type SourceDraft, SourceFields, sourceInput } from "@/components/source-settings";
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
        retention_days: RETENTION_DAYS,
      });
    } catch (failure) {
      return (failure as Error).message;
    }
    const made = project.current;
    try {
      source.current ??= await api<Source>(
        `/products/${made.id}/sources`,
        "POST",
        sourceInput(sourceDraft),
      );
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
      <div className="mx-auto grid min-h-svh w-full min-w-0 max-w-[42rem] grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr_auto] px-6 sm:px-10">
        <header className="flex h-20 items-center justify-between gap-3">
          <a href="/" className="brand-link" aria-label="Highkey">
            <span className="brand">
              <img className="brand-mark" src="/favicon.svg?v=7" width="30" height="30" alt="" />
              <span className="brand-word">highkey</span>
            </span>
          </a>
        </header>
        {created ? (
          <Connect created={created} />
        ) : (
          <main className="flex min-w-0 flex-col gap-5 pt-4 pb-10 sm:pt-8">
            {creates ? (
              <>
                <h1 className="text-[34px] leading-[1.1] lg:text-[40px]">
                  {first ? "Create your first project" : "Create a project"}
                </h1>
                <Lead>
                  Name your project and its first source. You can connect your app now or later.
                </Lead>
                <form
                  id="new-project-form"
                  className="auth-form"
                  method="post"
                  onSubmit={form.onSubmit}
                >
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
                  <div className={`mt-1 grid min-w-0 gap-4 pt-5 ${SEAM}`}>
                    <SourceFields
                      value={sourceDraft}
                      onChange={setSourceDraft}
                      label="Source"
                      hint="The website, app, or tool that sends events."
                    />
                  </div>
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
          className={`sticky bottom-0 z-10 bg-background pb-[env(safe-area-inset-bottom)] ${SEAM}`}
        >
          {creates && (
            <div className="flex min-h-16 items-center justify-end gap-3 py-2">
              {created ? (
                <Button
                  className="w-40"
                  nativeButton={false}
                  role="link"
                  render={<a href={`/${organization.slug}/${created.project.slug}`} />}
                >
                  Open project
                </Button>
              ) : (
                <SubmitButton pending={form.pending} form="new-project-form" compact>
                  Create project
                </SubmitButton>
              )}
            </div>
          )}
          <div className="flex min-h-10 items-center justify-between gap-3 text-[13px] text-muted-foreground">
            <span className="flex min-w-0 items-baseline gap-2.5">
              <span>Organization:</span>
              <strong className="truncate font-semibold text-foreground">
                {organization.name}
              </strong>
              <Button
                variant="link"
                size="sm"
                className="px-0"
                nativeButton={false}
                role="link"
                render={<a href="/welcome" />}
              >
                Switch
              </Button>
            </span>
            <button type="button" className={LINK} onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
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
            {created ? "Your project is ready" : "Start with one source"}
          </h2>
          <p className={HINT}>
            {created
              ? "You can find the install guide again in project settings."
              : "The source you name here is created with your project. If you start with your website, you can add your mobile app later in Settings → Sources → Add source."}
          </p>
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

/** Creation is complete. Installing the SDK is optional and can be resumed in Settings. */
function Connect({ created }: { created: Created }) {
  const { project, source, key } = created;
  const [integration, setIntegration] = useState<Integration>("browser");
  const [copyFailed, setCopyFailed] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  // The form is gone: focus moves to what replaced it.
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, []);
  return (
    <main className="flex w-full min-w-0 max-w-[720px] flex-col gap-6 pt-2 pb-16">
      <h1
        ref={heading}
        tabIndex={-1}
        className="text-[34px] leading-[1.1] outline-none [overflow-wrap:anywhere] lg:text-[40px]"
      >
        {project.name} is ready
      </h1>
      <section aria-label="Source key">
        <h2 className="text-sm font-semibold">Public ingestion key for {source.name}</h2>
        <div className="my-2 flex items-center gap-2 rounded-md border bg-surface-inset px-3 py-2.5 font-mono text-[13px] [overflow-wrap:anywhere]">
          <code data-testid="ingestion-key" className="min-w-0 flex-1">
            {key}
          </code>
          <CopyButton variant="ghost" aria-label="Copy ingestion key" content={key} />
        </div>
        <p className={HINT}>
          Copy this key before leaving. It’s shown only once. You can create another in project
          settings.
        </p>
      </section>
      <FirstEventNotice id={project.id} source={source} />
      <details className={`pt-4 ${SEAM}`}>
        <summary className="w-fit cursor-pointer font-semibold text-primary">
          View SDK install guide
        </summary>
        <div className="mt-4 grid min-w-0 gap-4">
          <Lead>
            Choose your platform and copy the snippet for {source.name}. You can also find these
            instructions in project settings.
          </Lead>
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
          {source.website_urls?.some((url) => !url.includes("*")) && (
            <WebsiteCheck id={project.id} source={source.id} />
          )}
          <details className={`pt-5 ${SEAM}`}>
            <summary>Connect an agent (optional)</summary>
            <p className={`my-3 ${HINT}`}>
              Ask Claude Code or Codex about {project.name}, or have it build dashboards and views.
            </p>
            <ConnectAgent />
          </details>
        </div>
      </details>
    </main>
  );
}
