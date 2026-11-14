import { workspaceTarget } from "@/lib/workspace-route";
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Cancel01Icon,
  ComputerTerminal02Icon,
  CubeIcon,
  DashboardSquare01Icon,
  HelpCircleIcon,
  Search01Icon,
  Settings02Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarTrigger,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  useSidebar,
} from "@/components/ui/sidebar";
import type { Product } from "@/lib/api";
import { DitherField } from "./dither-field";
import { SourceIcon } from "./source-icon";

export function WorkspaceSidebar({
  path,
  product,
  sourceId,
  picker,
  navigationReady,
  onSourceChange,
}: {
  path: string;
  product?: Product;
  sourceId?: string;
  picker: ReactNode;
  navigationReady: boolean;
  /** Receives the chosen source's slug, or an empty string for All sources. */
  onSourceChange: (slug: string) => void;
}) {
  const { isMobile, setOpenMobile, open } = useSidebar();
  const sources = [
    { id: "", slug: "", name: "All sources", icon: null },
    ...(product?.sources ?? []),
  ];
  return (
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
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup className="workspace-sources">
          <SidebarGroupLabel>Sources</SidebarGroupLabel>
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
                        onSourceChange(source.slug);
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
  );
}
