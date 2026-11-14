import { useEffect, useRef, useState, type ComponentProps, type ReactElement } from "react";
import { useNavigate } from "@tanstack/react-router";
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
import {
  createView,
  deleteView,
  getView,
  saveView,
  specToQuery,
  viewErrorMessage,
  type EventViewDocument,
  type StoredView,
  type ViewDocument,
  type ViewLink,
} from "@/lib/views";
import { workspaceTarget } from "@/lib/workspace-route";
import { AgentGuideDialog } from "./dashboards/agent-guide";
import { useWorkspace } from "./app-shell";
import { NameDialog } from "./name-dialog";

/** A link to a saved view; extra props (children, class, click handler) come from the list. */
export type ViewLinkRenderer = (view: ViewLink, props?: ComponentProps<"a">) => ReactElement;

/**
 * The saved views nested under Events or Logs, by name, with the active one marked and a button
 * that saves the current query last.
 */
export function ViewList({
  label,
  views,
  activeSlug,
  link,
  saveLabel = "Save view",
  onSave,
  onNavigate,
}: {
  label: string;
  views: ViewLink[];
  activeSlug?: string;
  link: ViewLinkRenderer;
  saveLabel?: string;
  onSave: () => void;
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
        <SidebarMenuSubButton render={<button type="button" />} onClick={onSave}>
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden="true" className="size-3.5" />
          <span>{saveLabel}</span>
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
  return (
    <NameDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Save view"
      description="Saves this query under a name in the sidebar. The date range and source stay with the toolbar."
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
            query: specToQuery(spec),
          });
        } catch (error) {
          throw new Error(viewErrorMessage(error, "Could not save the view."));
        }
        onOpenChange(false);
        await reload();
        await navigate({
          ...workspaceTarget("/events", product.slug),
          search: (previous: ExploreSearch) => ({
            ...previous,
            view: stored.slug,
            query: spec,
            page: undefined,
          }),
          resetScroll: false,
        });
      }}
    />
  );
}

/**
 * An open view's overflow menu. Update replaces the view's query with the page's current one,
 * Rename keeps the query, Copy JSON hands the stored document to the clipboard, Edit shows how to
 * change the view through an agent and Delete asks first. Results and failures show beside it.
 */
export function ViewActions<D extends ViewDocument>({
  product,
  view,
  withCurrent,
  onDeleted,
}: {
  product: Product;
  view: ViewLink;
  /** The stored document with the page's current query in place of its own. */
  withCurrent: (stored: D) => D;
  /** Leaves the deleted view's page, after the sidebar has dropped it. */
  onDeleted: () => void | Promise<void>;
}) {
  const { reload } = useWorkspace();
  const trigger = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [guiding, setGuiding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const kind = view.kind as D["kind"];
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
  const stored = () => getView<D>(product.slug, view.slug, kind);
  const update = () =>
    run("Updated", async () => {
      const current = await stored();
      await saveView(product.id, view.slug, withCurrent(current.document));
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
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button ref={trigger} variant="outline" size="icon" aria-label="View actions" />}
        >
          <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          <DropdownMenuItem onClick={() => void update()}>
            Update view with current query
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
        description="The query stays as it is."
        initialName={view.name}
        submitLabel="Rename"
        failure="Could not rename the view."
        finalFocus={trigger}
        onSubmit={async (name) => {
          try {
            const current = await stored();
            await saveView(product.id, view.slug, { ...current.document, name });
          } catch (e) {
            throw new Error(viewErrorMessage(e, "Could not rename the view."));
          }
          await reload();
        }}
      />
      <AgentGuideDialog
        open={guiding}
        onOpenChange={setGuiding}
        mode="view"
        project={product}
        view={{ slug: view.slug, name: view.name, kind: view.kind }}
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
