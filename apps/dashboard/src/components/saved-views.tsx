import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import type { Product } from "@/lib/api";
import type { ExploreSearch, ExploreSpec } from "@/lib/explore-search";
import type { LogsSearch } from "@/lib/logs";
import {
  appliedState,
  createView,
  eventViewState,
  logViewState,
  deleteView,
  getView,
  logsToQuery,
  rememberApplied,
  saveView,
  specToQuery,
  viewErrorMessage,
  viewIdentity,
  viewQueries,
  viewSync,
  type EventViewDocument,
  type LogViewDocument,
  type StoredView,
  type ViewDocument,
  type ViewKind,
  type ViewLink,
} from "@/lib/views";
import { workspaceTarget } from "@/lib/workspace-route";
import { AgentGuideDialog } from "./dashboards/agent-guide";
import { PageHeader, useWorkspace } from "./app-shell";
import { NameDialog } from "./name-dialog";
import { ErrorState } from "./shared";

/** A link to a saved view; extra props (children, class, click handler) come from the list. */
export type ViewLinkRenderer = (view: ViewLink, props?: ComponentProps<"a">) => ReactElement;

/**
 * The saved views nested under Events or Logs, by name, with the active one marked and New view
 * last.
 */
export function ViewList({
  label,
  views,
  activeSlug,
  link,
  newLabel = "New view",
  onNew,
  onNavigate,
}: {
  label: string;
  views: ViewLink[];
  activeSlug?: string;
  link: ViewLinkRenderer;
  newLabel?: string;
  /** Opens the agent guide for a new view; it never navigates. */
  onNew: () => void;
  onNavigate: () => void;
}) {
  return (
    <SidebarMenuSub aria-label={label} className="workspace-dashboards workspace-views">
      {views.map((view) => (
        <SidebarMenuSubItem key={view.id}>
          <SidebarMenuSubButton
            isActive={view.slug === activeSlug}
            title={view.name}
            render={link(view, { onClick: onNavigate })}
          >
            <span>{view.name}</span>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ))}
      <SidebarMenuSubItem>
        <SidebarMenuSubButton render={<button type="button" />} onClick={onNew}>
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden="true" className="size-3.5" />
          <span>{newLabel}</span>
        </SidebarMenuSubButton>
      </SidebarMenuSubItem>
    </SidebarMenuSub>
  );
}

/** Whether the nested list has room: the collapsed rail swaps it for a popover. */
export function useCollapsedRail() {
  const { isMobile, state } = useSidebar();
  return state === "collapsed" && !isMobile;
}

/**
 * In the collapsed rail the nested list has no room, so the page's rail button opens a small menu
 * with the page, its items and the save action. It is a nonmodal popover: focus moves to its first
 * link, Tab walks the links, and Escape returns focus to the rail.
 */
export function CollapsedGroup({
  label,
  icon,
  active,
  home,
  itemsLabel,
  items,
  actionLabel,
  onAction,
}: {
  label: string;
  icon: Parameters<typeof HugeiconsIcon>[0]["icon"];
  /** The page or one of its items is open. */
  active: boolean;
  /** The link to the page itself; a render function so the caller owns the route. */
  home: (props: ComponentProps<"a">) => ReactElement;
  itemsLabel: string;
  items: {
    key: string;
    name: string;
    active: boolean;
    link: (props: ComponentProps<"a">) => ReactElement;
  }[];
  actionLabel: string;
  onAction: () => void;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const menuLink = { className: "workspace-dashboards-menu-link", onClick: close };
  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger render={<SidebarMenuButton isActive={active} />}>
        <HugeiconsIcon icon={icon} strokeWidth={2} aria-hidden="true" />
        <span className="sr-only">{label}</span>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={8}
        className="workspace-dashboards-menu"
        aria-label={label}
      >
        {home({ ...menuLink, children: label })}
        <span className="workspace-dashboards-menu-label" aria-hidden="true">
          {itemsLabel}
        </span>
        <ul aria-label={itemsLabel}>
          {items.map((item) => (
            <li key={item.key}>
              {item.link({
                ...menuLink,
                ...(item.active ? { "data-active": "" } : {}),
                title: item.name,
                children: item.name,
              } as ComponentProps<"a">)}
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="workspace-dashboards-menu-link"
          onClick={() => {
            close();
            onAction();
          }}
        >
          {actionLabel}
        </button>
      </PopoverContent>
    </Popover>
  );
}

/** How a page shows saved views of its kind; Events and Logs each define one. */
export type SavedViewPage<D extends ViewDocument> = {
  kind: D["kind"];
  path: "/events" | "/logs";
  title: "Events" | "Logs";
  /** What a view holds on this page: the Events query, the Logs filters. */
  noun: "query" | "filters";
  /** The search that shows a stored view, or undefined when this page cannot run it. */
  search: (stored: StoredView<D>) => Record<string, unknown> | undefined;
  /** What the page shows of a view document, comparable with the page's own state. */
  stateOf: (document: D) => string;
  /** The search that leaves the view. */
  clear: (previous: Record<string, unknown>) => Record<string, unknown>;
};

const viewQueryKey = (productId: string, kind: ViewKind, slug: string) =>
  [...viewQueries, productId, kind, slug] as const;
/**
 * The stored view a page opened, cached so its open screen and its actions read one copy. The
 * workspace refetches it on a dashboards signal (an agent saved it, say).
 */
function useStoredView<D extends ViewDocument>(product: Product, kind: D["kind"], slug: string) {
  return useQuery<StoredView<D>, Error & { status?: number }>({
    queryKey: viewQueryKey(product.id, kind, slug),
    queryFn: ({ signal }) => getView<D>(product.slug, slug, kind, signal),
    // A screen that just read it and the actions that mount next share one request.
    staleTime: 2_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

/** Applies a stored view version to the page in place, remembering what that showed. */
function useShowView<D extends ViewDocument>(page: SavedViewPage<D>, product: Product) {
  const navigate = useNavigate();
  return (slug: string, stored: StoredView<D>, patch = page.search(stored)) => {
    rememberApplied(
      viewIdentity(product.id, page.kind, slug),
      stored.updated_at,
      page.stateOf(stored.document),
    );
    return navigate({
      ...workspaceTarget(page.path, product.slug),
      // A version the page cannot run drops the marker, so the open screen explains it.
      search: (previous: Record<string, unknown>) =>
        patch
          ? { ...previous, ...patch, view: slug, viewAt: stored.updated_at }
          : { ...previous, viewAt: undefined },
      replace: true,
      resetScroll: false,
    });
  };
}

/**
 * A saved view named in the URL that the page has not applied yet (no `viewAt`): loads it and
 * writes its query and version into the URL, so reloads and history keep them. A view the page
 * cannot run says so and offers the agent guide; it opens by itself once an agent fixes it.
 */
export function OpenSavedView<D extends ViewDocument>({
  page,
  product,
  slug,
  loading,
}: {
  page: SavedViewPage<D>;
  product: Product;
  slug: string;
  /** The page's own placeholder while the view loads. */
  loading: ReactNode;
}) {
  const view = useStoredView<D>(product, page.kind, slug);
  const show = useShowView(page, product);
  const [guiding, setGuiding] = useState(false);
  // The screen reads whatever is cached, so a refetch leaves it (and its dialog) alone.
  const stored = view.error ? undefined : view.data;
  const patch = stored ? page.search(stored) : undefined;
  const version = patch && stored?.updated_at;
  // Only a version that just finished loading applies, never a cached copy that is revalidating.
  const settled = !view.isFetching;
  // biome-ignore lint/correctness/useExhaustiveDependencies: applies each readable version once
  useEffect(() => {
    if (settled && stored && patch) void show(slug, stored, patch);
  }, [version, settled]);
  const clear = (label: string) => (
    <Button
      variant="outline"
      nativeButton={false}
      role="link"
      render={
        <Link
          {...workspaceTarget(page.path, product.slug)}
          search={(previous: Record<string, unknown>) => page.clear(previous)}
        />
      }
    >
      {label}
    </Button>
  );
  if (view.error?.status === 404)
    return (
      <>
        <PageHeader
          title="This view no longer exists"
          description={`It may have been deleted. The project’s other views and its ${page.kind} are unchanged.`}
        />
        {clear("Clear selection")}
      </>
    );
  if (stored && !patch)
    return (
      <>
        <PageHeader
          title={`This view uses settings ${page.title} can’t show`}
          description={`${stored.document.name} was saved with ${page.noun === "query" ? "a query" : "filters"} this page cannot run. Ask your agent to change it, or clear the view.`}
        />
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => setGuiding(true)}>
            Edit with your agent
          </Button>
          {clear("Clear view")}
        </div>
        <AgentGuideDialog
          open={guiding}
          onOpenChange={setGuiding}
          intent={{
            type: "edit-view",
            view: { slug, name: stored.document.name, kind: page.kind },
          }}
          project={product}
        />
      </>
    );
  return (
    <>
      <PageHeader title={page.title} description="Opening the saved view…" />
      {view.error ? (
        <ErrorState
          message="The saved view could not be loaded."
          retry={() => void view.refetch()}
        />
      ) : (
        loading
      )}
    </>
  );
}

/** Saves the Events page's current query as a named view, then opens it. */
export function SaveEventViewDialog({
  open,
  onOpenChange,
  product,
  spec,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: Product;
  spec: ExploreSpec;
}) {
  const { reload } = useWorkspace();
  const navigate = useNavigate();
  const query = specToQuery(spec);
  return (
    <NameDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Save view"
      description={`Saves this query under a name in the sidebar. The date range and source stay with the toolbar.${spec.source ? " The client filter isn’t saved." : ""}`}
      initialName=""
      submitLabel="Save view"
      failure="Could not save the view."
      onSubmit={async (name) => {
        let stored: StoredView<EventViewDocument>;
        try {
          stored = await createView<EventViewDocument>(product.id, {
            version: 1,
            kind: "events",
            name,
            query,
          });
        } catch (error) {
          throw new Error(viewErrorMessage(error, "Could not save the view."));
        }
        rememberApplied(
          viewIdentity(product.id, "events", stored.slug),
          stored.updated_at,
          eventViewState(spec),
        );
        onOpenChange(false);
        await reload();
        await navigate({
          ...workspaceTarget("/events", product.slug),
          search: (previous: ExploreSearch) => ({
            ...previous,
            view: stored.slug,
            viewAt: stored.updated_at,
            query: spec,
            page: undefined,
          }),
          resetScroll: false,
        });
      }}
    />
  );
}

/** The Events header's action when no view is open: saves the query on screen as a view. */
export function SaveEventViewButton({ product, spec }: { product: Product; spec: ExploreSpec }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        Save view
      </Button>
      <SaveEventViewDialog open={open} onOpenChange={setOpen} product={product} spec={spec} />
    </>
  );
}

/** The Logs header's action when no view is open: saves the filters on screen as a view. */
export function SaveLogViewButton({ product, search }: { product: Product; search: LogsSearch }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        Save view
      </Button>
      <SaveLogViewDialog open={open} onOpenChange={setOpen} product={product} search={search} />
    </>
  );
}

/** Saves the Logs page's current filters and time window as a named view, then opens it. */
export function SaveLogViewDialog({
  open,
  onOpenChange,
  product,
  search,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: Product;
  search: LogsSearch;
}) {
  const { reload } = useWorkspace();
  const navigate = useNavigate();
  // A trace ID and a selected range narrow this page only; a view keeps its window instead.
  const unsaved = [
    search.trace ? "The trace ID filter isn’t saved." : "",
    search.logFrom ? "The selected range isn’t saved; the view keeps the time window." : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <NameDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Save view"
      description={`Saves these filters and the time window under a name in the sidebar. The workspace source stays with the toolbar.${unsaved ? ` ${unsaved}` : ""}`}
      initialName=""
      submitLabel="Save view"
      failure="Could not save the view."
      onSubmit={async (name) => {
        let stored: StoredView<LogViewDocument>;
        try {
          stored = await createView<LogViewDocument>(product.id, {
            version: 1,
            kind: "logs",
            name,
            query: logsToQuery(search),
            ...(search.logWindow ? { window: search.logWindow } : {}),
          });
        } catch (error) {
          throw new Error(viewErrorMessage(error, "Could not save the view."));
        }
        const logWindow = search.logWindow ?? "1h";
        rememberApplied(
          viewIdentity(product.id, "logs", stored.slug),
          stored.updated_at,
          logViewState({ ...search, logWindow }),
        );
        onOpenChange(false);
        await reload();
        await navigate({
          ...workspaceTarget("/logs", product.slug),
          search: (previous: LogsSearch) => ({
            ...previous,
            view: stored.slug,
            viewAt: stored.updated_at,
            logWindow,
          }),
          resetScroll: false,
        });
      }}
    />
  );
}

/**
 * An open view's actions, kept in step with the stored view. A newer version applies in place
 * when the page shows what it applied, or waits behind "Changed by your agent · Load latest" when
 * the page has changes of its own. Update replaces the view's query with the page's current one,
 * and refuses while a newer version waits, so it never reverts another change. Rename keeps the
 * query, Copy JSON hands the stored document to the clipboard, Edit shows how to change the view
 * through an agent and Delete asks first. Results and failures show beside it.
 */
export function ViewActions<D extends ViewDocument>({
  product,
  view,
  page,
  appliedAt,
  state,
  withCurrent,
  onDeleted,
}: {
  product: Product;
  view: ViewLink;
  page: SavedViewPage<D>;
  /** The `updated_at` of the version the page applied (its `viewAt`). */
  appliedAt: string;
  /** What the page shows now, as `page.stateOf` reads a document. */
  state: string;
  /** The stored document with the page's current query or filters in place of its own. */
  withCurrent: (stored: D) => D;
  /** Leaves the deleted view's page, after the sidebar has dropped it. */
  onDeleted: () => void | Promise<void>;
}) {
  const { reload } = useWorkspace();
  const client = useQueryClient();
  const navigate = useNavigate();
  const show = useShowView(page, product);
  const trigger = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [guiding, setGuiding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const kind = view.kind as D["kind"];
  const noun = page.noun;
  const identity = viewIdentity(product.id, kind, view.slug);
  const key = viewQueryKey(product.id, kind, view.slug);
  const latest = useStoredView<D>(product, kind, view.slug).data;
  const syncWith = (stored: StoredView<D>) =>
    viewSync({
      appliedAt,
      applied: appliedState(identity, appliedAt),
      page: state,
      stored: { at: stored.updated_at, state: page.stateOf(stored.document) },
    });
  const sync = latest ? syncWith(latest) : "current";
  // Moves the applied marker to a version whose query the page already shows or started from.
  const mark = (stored: StoredView<D>) => {
    rememberApplied(identity, stored.updated_at, page.stateOf(stored.document));
    void navigate({
      ...workspaceTarget(page.path, product.slug),
      search: (previous: Record<string, unknown>) => ({
        ...previous,
        viewAt: stored.updated_at,
      }),
      replace: true,
      resetScroll: false,
    });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: acts once per stored version
  useEffect(() => {
    if (!latest) return;
    if (sync === "bump") mark(latest);
    else if (sync === "apply") void show(view.slug, latest);
  }, [sync, latest?.updated_at]);
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(""), 2500);
    return () => clearTimeout(timer);
  }, [status]);

  async function run(message: string, work: () => Promise<void>) {
    setError("");
    setStatus("");
    try {
      await work();
      setStatus(message);
    } catch (e) {
      setError(viewErrorMessage(e, "Something went wrong. Try again."));
    }
  }
  const stored = async () => {
    const current = await getView<D>(product.slug, view.slug, kind);
    client.setQueryData(key, current);
    return current;
  };
  const update = () =>
    run("Updated", async () => {
      const current = await stored();
      // Writing over a newer query would revert it without anyone seeing it.
      if (!["current", "bump"].includes(syncWith(current)))
        throw new Error(
          `This view changed after you opened it. Load the latest version before you update it with your ${noun}.`,
        );
      const saved = await saveView(product.id, view.slug, withCurrent(current.document));
      client.setQueryData(key, saved);
      mark(saved);
      await reload();
    });
  const copyJson = () =>
    run("Copied", async () => {
      const current = await stored();
      try {
        await navigator.clipboard.writeText(JSON.stringify(current.document, null, 2));
      } catch {
        throw new Error("Could not copy to the clipboard. Allow clipboard access and try again.");
      }
    });
  async function remove() {
    setBusy(true);
    setError("");
    try {
      await deleteView(product.id, view.slug, kind);
      setConfirming(false);
      await reload();
      await onDeleted();
    } catch (e) {
      setConfirming(false);
      setError(viewErrorMessage(e, "Could not delete the view."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="dashboard-actions">
      <span role="status" className="dashboard-actions-status">
        {status}
      </span>
      {/* Mounted before it speaks, so screen readers announce a waiting version. */}
      <span role="status" className={sync === "changed" ? "dashboard-stale" : "sr-only"}>
        {sync === "changed" ? "Changed by your agent" : ""}
      </span>
      {sync === "changed" && latest && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setError("");
            void show(view.slug, latest);
          }}
        >
          Load latest
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button ref={trigger} variant="outline" size="icon" aria-label="View actions" />}
        >
          <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          <DropdownMenuItem onClick={() => void update()}>
            Update view with current {noun}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setRenaming(true)}>Rename</DropdownMenuItem>
          <DropdownMenuItem onClick={() => void copyJson()}>Copy JSON</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setGuiding(true)}>Edit with your agent</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setConfirming(true)}>
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <NameDialog
        open={renaming}
        onOpenChange={setRenaming}
        title="Rename view"
        description={`The ${noun} stays as it is.`}
        initialName={view.name}
        submitLabel="Rename"
        failure="Could not rename the view."
        finalFocus={trigger}
        onSubmit={async (name) => {
          let saved: StoredView<D>;
          let inStep: boolean;
          try {
            const current = await stored();
            inStep = ["current", "bump"].includes(syncWith(current));
            saved = await saveView(product.id, view.slug, { ...current.document, name });
          } catch (e) {
            throw new Error(viewErrorMessage(e, "Could not rename the view."));
          }
          client.setQueryData(key, saved);
          // A new name changes nothing the page shows, so the page stays on this version.
          if (inStep) mark(saved);
          await reload();
        }}
      />
      <AgentGuideDialog
        open={guiding}
        onOpenChange={setGuiding}
        intent={{ type: "edit-view", view: { slug: view.slug, name: view.name, kind: view.kind } }}
        project={product}
        finalFocus={trigger}
      />
      {error && (
        <Alert variant="destructive" role="alert" className="dashboard-actions-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <AlertDialog open={confirming} onOpenChange={(next) => !busy && setConfirming(next)}>
        <AlertDialogContent finalFocus={trigger}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {view.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Your events, logs and dashboards are not affected. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy} onClick={() => void remove()}>
              {busy && <Spinner data-icon="inline-start" aria-hidden="true" />}
              Delete view
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
