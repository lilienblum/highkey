import { useWorkspaceTarget } from "@/lib/workspace-route";
import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  Cancel01Icon,
  ComputerTerminal02Icon,
  Coins01Icon,
  AiBrain01Icon,
  Clock01Icon,
  Pulse01Icon,
  UserGroupIcon,
  CubeIcon,
  DashboardSquare01Icon,
  AiChat02Icon,
  Search01Icon,
  Settings02Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogTrigger } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarTrigger,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar";
import type { DashboardLink, Product } from "@/lib/api";
import { clearedLogs } from "@/lib/logs";
import { AgentGuideDialog, AgentSetupContent, type GuideIntent } from "./dashboards/agent-guide";
import { DitherField } from "./dither-field";
import { OrganizationMenu } from "./organization-menu";
import { CollapsedGroup, ViewList, useCollapsedRail, type ViewLinkRenderer } from "./saved-views";
import { SourceIcon } from "./source-icon";

export function WorkspaceSidebar({
  path,
  dashboardSlug,
  eventViewSlug,
  logViewSlug,
  product,
  sourceId,
  picker,
  navigationReady,
  onSourceChange,
}: {
  path: string | null;
  /** The open dashboard, when the page is one. */
  dashboardSlug?: string;
  /** The open event view, when the page is Events with one applied. */
  eventViewSlug?: string;
  /** The open log view, when the page is Logs with one applied. */
  logViewSlug?: string;
  product?: Product;
  sourceId?: string;
  picker: ReactNode;
  navigationReady: boolean;
  onSourceChange: (id: string) => void;
}) {
  const workspaceTarget = useWorkspaceTarget();
  const { isMobile, setOpenMobile, open, state } = useSidebar();
  const sources = [{ id: "", name: "All sources", icon: null }, ...(product?.sources ?? [])];
  const dashboards = product?.dashboards ?? [];
  const eventViews = (product?.views ?? []).filter((view) => view.kind === "events");
  // New dashboard and New view open the guide where you are; creating is not a navigation.
  const [guide, setGuide] = useState<GuideIntent>({ type: "new-dashboard" });
  const [guiding, setGuiding] = useState(false);
  const openGuide = (intent: GuideIntent) => {
    setOpenMobile(false);
    setGuide(intent);
    setGuiding(true);
  };
  const logViews = (product?.views ?? []).filter((view) => view.kind === "logs");
  const collapsedRail = useCollapsedRail();
  const eventsTarget = workspaceTarget("/events", product?.slug);
  const logsTarget = workspaceTarget("/logs", product?.slug);
  const eventViewLink: ViewLinkRenderer = (view, props) => (
    <Link
      {...eventsTarget}
      search={(previous) => ({
        ...previous,
        ...eventsTarget.search,
        view: view.slug,
        viewAt: undefined,
        query: undefined,
        page: undefined,
        drilldown: undefined,
        // A view replaces whatever made the current link invalid.
        invalidQuery: undefined,
        invalidDrilldown: undefined,
      })}
      {...(props as object)}
    />
  );
  const logViewLink: ViewLinkRenderer = (view, props) => (
    <Link
      {...logsTarget}
      search={(previous) => ({
        ...previous,
        ...logsTarget.search,
        ...clearedLogs,
        view: view.slug,
      })}
      {...(props as object)}
    />
  );
  const newEventView = () => openGuide({ type: "new-view", kind: "events" });
  const newLogView = () => openGuide({ type: "new-view", kind: "logs" });
  return (
    <>
      <Sidebar collapsible="icon" className="workspace-sidebar">
        <SidebarHeader className="workspace-identity">
          <DitherField />
          <div className="workspace-brand-row">
            <Link
              {...workspaceTarget("/", product?.slug)}
              aria-label="Highkey overview"
              className="brand-link"
              onClick={() => setOpenMobile(false)}
            >
              <span className="brand">
                <img className="brand-mark" src="/favicon.svg?v=7" width="30" height="30" alt="" />
                <span className="brand-word">highkey</span>
              </span>
            </Link>
            {isMobile ? (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close navigation"
                onClick={() => setOpenMobile(false)}
              >
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} aria-hidden="true" />
              </Button>
            ) : (
              <SidebarTrigger
                className="workspace-sidebar-toggle"
                disabled={!navigationReady}
                aria-expanded={navigationReady ? open : undefined}
                title={open ? "Collapse sidebar" : "Expand sidebar"}
              />
            )}
          </div>
          <div className="workspace-project" title={product?.name}>
            {picker}
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup className="workspace-navigation">
            <SidebarGroupContent>
              <nav aria-label="Main navigation">
                <SidebarMenu>
                  {(
                    [
                      ["/", "Overview", DashboardSquare01Icon],
                      ["/realtime", "Realtime", Pulse01Icon],
                      ["/events", "Events", Search01Icon],
                      ["/sessions", "Sessions", Clock01Icon],
                      ["/people", "Profiles", UserGroupIcon],
                      ["/revenue", "Revenue", Coins01Icon],
                      ["/ai", "AI costs", AiBrain01Icon],
                      ["/logs", "Logs", ComputerTerminal02Icon],
                      ["/settings", "Project settings", Settings02Icon],
                    ] as const
                  ).map(([to, label, icon]) => (
                    <SidebarMenuItem key={to}>
                      {to === "/" && dashboards.length > 0 && state === "collapsed" && !isMobile ? (
                        <CollapsedOverview
                          product={product}
                          dashboards={dashboards}
                          active={path === "/"}
                          activeDashboard={dashboardSlug}
                          onNew={() => openGuide({ type: "new-dashboard" })}
                        />
                      ) : to === "/events" && eventViews.length > 0 && collapsedRail ? (
                        <CollapsedGroup
                          label="Events"
                          icon={Search01Icon}
                          active={path === "/events"}
                          home={(props) => (
                            <Link
                              {...workspaceTarget("/events", product?.slug)}
                              {...(props as object)}
                            />
                          )}
                          itemsLabel="Views"
                          items={eventViews.map((view) => ({
                            key: view.id,
                            name: view.name,
                            active: view.slug === eventViewSlug,
                            link: (props) => eventViewLink(view, props),
                          }))}
                          actionLabel="New view"
                          onAction={newEventView}
                        />
                      ) : to === "/logs" && logViews.length > 0 && collapsedRail ? (
                        <CollapsedGroup
                          label="Logs"
                          icon={ComputerTerminal02Icon}
                          active={path === "/logs"}
                          home={(props) => (
                            <Link
                              {...workspaceTarget("/logs", product?.slug)}
                              {...(props as object)}
                            />
                          )}
                          itemsLabel="Views"
                          items={logViews.map((view) => ({
                            key: view.id,
                            name: view.name,
                            active: view.slug === logViewSlug,
                            link: (props) => logViewLink(view, props),
                          }))}
                          actionLabel="New view"
                          onAction={newLogView}
                        />
                      ) : (
                        <SidebarMenuButton
                          isActive={path === to}
                          tooltip={label}
                          render={
                            <Link
                              {...workspaceTarget(to, product?.slug)}
                              onClick={() => setOpenMobile(false)}
                            />
                          }
                        >
                          <HugeiconsIcon icon={icon} strokeWidth={2} aria-hidden="true" />
                          <span className="group-data-[collapsible=icon]:sr-only">{label}</span>
                        </SidebarMenuButton>
                      )}
                      {to === "/" && product && (
                        <SidebarMenuSub aria-label="Dashboards" className="workspace-dashboards">
                          {dashboards.map((dashboard) => (
                            <SidebarMenuSubItem key={dashboard.id}>
                              <SidebarMenuSubButton
                                isActive={dashboard.slug === dashboardSlug}
                                title={dashboard.name}
                                render={
                                  <Link
                                    {...workspaceTarget(
                                      "/dashboards",
                                      product?.slug,
                                      dashboard.slug,
                                    )}
                                    onClick={() => setOpenMobile(false)}
                                  />
                                }
                              >
                                <span>{dashboard.name}</span>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          ))}
                          <SidebarMenuSubItem>
                            <SidebarMenuSubButton
                              render={<button type="button" />}
                              onClick={() => openGuide({ type: "new-dashboard" })}
                            >
                              <HugeiconsIcon
                                icon={Add01Icon}
                                strokeWidth={2}
                                aria-hidden="true"
                                className="size-3.5"
                              />
                              <span>New dashboard</span>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        </SidebarMenuSub>
                      )}
                      {to === "/logs" && product && (
                        <ViewList
                          label="Log views"
                          views={logViews}
                          activeSlug={logViewSlug}
                          link={logViewLink}
                          onNew={newLogView}
                          onNavigate={() => setOpenMobile(false)}
                        />
                      )}
                      {to === "/events" && product && (
                        <ViewList
                          label="Event views"
                          views={eventViews}
                          activeSlug={eventViewSlug}
                          link={eventViewLink}
                          onNew={newEventView}
                          onNavigate={() => setOpenMobile(false)}
                        />
                      )}
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </nav>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup className="workspace-sources">
            <SidebarGroupLabel>Sources</SidebarGroupLabel>
            {product && (
              <SidebarGroupAction
                aria-label="Connect a source"
                title="Connect a source"
                render={
                  <Link
                    {...workspaceTarget("/settings", product.slug)}
                    hash="logs"
                    onClick={() => setOpenMobile(false)}
                  />
                }
              >
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden="true" />
              </SidebarGroupAction>
            )}
            <SidebarGroupContent>
              <nav aria-label="Project sources">
                <SidebarMenu>
                  {sources.map((source) => (
                    <SidebarMenuItem key={source.id}>
                      <SidebarMenuButton
                        data-scope="source"
                        disabled={!product}
                        isActive={(sourceId ?? "") === source.id}
                        aria-pressed={(sourceId ?? "") === source.id}
                        aria-label={source.name}
                        tooltip={source.name}
                        title={source.name}
                        onClick={() => {
                          onSourceChange(source.id);
                          setOpenMobile(false);
                        }}
                      >
                        {source.id ? (
                          <SourceIcon name={source.name} icon={source.icon} />
                        ) : (
                          <HugeiconsIcon icon={CubeIcon} strokeWidth={2} aria-hidden="true" />
                        )}
                        <span className="min-w-0 flex-1 truncate group-data-[collapsible=icon]:sr-only">
                          {source.name}
                        </span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                  {product && state === "collapsed" && !isMobile && (
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        tooltip="Connect a source"
                        render={
                          <Link {...workspaceTarget("/settings", product.slug)} hash="logs" />
                        }
                      >
                        <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden="true" />
                        <span className="sr-only">Connect a source</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )}
                </SidebarMenu>
              </nav>
              {product && !product.sources.length && (
                <p className="workspace-source-empty">
                  Connect your first source in Project settings.
                </p>
              )}
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="shrink-0">
          <SidebarMenu>
            <SidebarMenuItem>
              <Dialog>
                <SidebarMenuButton tooltip="Use with your agent" render={<DialogTrigger />}>
                  <HugeiconsIcon icon={AiChat02Icon} strokeWidth={2} aria-hidden="true" />
                  <span className="group-data-[collapsible=icon]:sr-only">Use with your agent</span>
                </SidebarMenuButton>
                <AgentSetupContent projectSlug={product?.slug} />
              </Dialog>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <OrganizationMenu projectSlug={product?.slug} />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      {product && (
        <AgentGuideDialog
          open={guiding}
          onOpenChange={setGuiding}
          intent={guide}
          project={product}
        />
      )}
    </>
  );
}

/**
 * In the collapsed rail the nested list has no room, so Overview opens a small menu with Overview
 * and the project's dashboards. It is a nonmodal popover: focus moves to its first link, Tab walks
 * the links, and Escape returns focus to the rail.
 */
function CollapsedOverview({
  product,
  dashboards,
  active,
  activeDashboard,
  onNew,
}: {
  product?: Product;
  dashboards: DashboardLink[];
  active: boolean;
  activeDashboard?: string;
  onNew: () => void;
}) {
  const workspaceTarget = useWorkspaceTarget();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger
        render={<SidebarMenuButton isActive={active || activeDashboard !== undefined} />}
      >
        <HugeiconsIcon icon={DashboardSquare01Icon} strokeWidth={2} aria-hidden="true" />
        <span className="sr-only">Overview</span>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={8}
        className="workspace-dashboards-menu"
        aria-label="Overview"
      >
        <Link
          {...workspaceTarget("/", product?.slug)}
          className="workspace-dashboards-menu-link"
          data-active={active ? "" : undefined}
          onClick={() => setOpen(false)}
        >
          Overview
        </Link>
        <span className="workspace-dashboards-menu-label" aria-hidden="true">
          Dashboards
        </span>
        <ul aria-label="Dashboards">
          {dashboards.map((dashboard) => (
            <li key={dashboard.id}>
              <Link
                {...workspaceTarget("/dashboards", product?.slug, dashboard.slug)}
                className="workspace-dashboards-menu-link"
                data-active={dashboard.slug === activeDashboard ? "" : undefined}
                title={dashboard.name}
                onClick={() => setOpen(false)}
              >
                {dashboard.name}
              </Link>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="workspace-dashboards-menu-link"
          onClick={() => {
            setOpen(false);
            onNew();
          }}
        >
          New dashboard
        </button>
      </PopoverContent>
    </Popover>
  );
}
