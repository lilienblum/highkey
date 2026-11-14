import { workspaceTarget } from "@/lib/workspace-route";
import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  Cancel01Icon,
  ComputerTerminal02Icon,
  CubeIcon,
  DashboardSquare01Icon,
  HelpCircleIcon,
  Search01Icon,
  Settings02Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
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
import { AgentGuideDialog } from "./dashboards/agent-guide";
import { DitherField } from "./dither-field";
import { SourceIcon } from "./source-icon";

export function WorkspaceSidebar({
  path,
  dashboardSlug,
  product,
  sourceId,
  picker,
  navigationReady,
  onSourceChange,
}: {
  path: string;
  /** The open dashboard, when the page is one. */
  dashboardSlug?: string;
  product?: Product;
  sourceId?: string;
  picker: ReactNode;
  navigationReady: boolean;
  onSourceChange: (id: string) => void;
}) {
  const { isMobile, setOpenMobile, open, state } = useSidebar();
  const sources = [{ id: "", name: "All sources", icon: null }, ...(product?.sources ?? [])];
  const dashboards = product?.dashboards ?? [];
  const [creating, setCreating] = useState(false);
  return (
    <>
      <Sidebar collapsible="icon" className="workspace-sidebar">
        <SidebarHeader className="workspace-identity">
          <DitherField />
          <div className="workspace-brand-row">
            <Link
              {...workspaceTarget("/", product?.slug)}
              aria-label="Piko overview"
              className="brand-link"
              onClick={() => setOpenMobile(false)}
            >
              <span className="brand">
                <img className="brand-mark" src="/favicon.svg?v=7" width="30" height="30" alt="" />
                <span className="brand-word">piko</span>
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
            <span className="workspace-section-label">Project</span>
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
                      ["/explore", "Explore", Search01Icon],
                      ["/logs", "Logs", ComputerTerminal02Icon],
                      ["/settings", "Settings", Settings02Icon],
                    ] as const
                  ).map(([to, label, icon]) => (
                    <SidebarMenuItem key={to}>
                      {to === "/" && dashboards.length > 0 && state === "collapsed" && !isMobile ? (
                        <CollapsedOverview
                          product={product}
                          dashboards={dashboards}
                          active={path === "/"}
                          activeDashboard={dashboardSlug}
                          onNew={() => setCreating(true)}
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
                              onClick={() => setCreating(true)}
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
                <p className="workspace-source-empty">Connect your first source in Settings.</p>
              )}
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Documentation"
                render={
                  <a
                    href="https://github.com/lilienblum/piko#readme"
                    target="_blank"
                    rel="noreferrer"
                  />
                }
              >
                <HugeiconsIcon icon={HelpCircleIcon} strokeWidth={2} aria-hidden="true" />
                <span className="group-data-[collapsible=icon]:sr-only">Documentation</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      {product && (
        <AgentGuideDialog
          open={creating}
          onOpenChange={setCreating}
          mode="create"
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
