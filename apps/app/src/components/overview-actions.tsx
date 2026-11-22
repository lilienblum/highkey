import { useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { overviewTemplate } from "@/lib/dashboards";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { DashboardNameDialog } from "./dashboards/new-dashboard-dialog";
import { ProjectInsights } from "./insights";
import { LanguageFilter } from "./language-filter";
import { PatternReports } from "./pattern-reports";

export function OverviewActions({ filters }: { filters: Record<string, unknown> }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [duplicating, setDuplicating] = useState(false);
  return (
    <>
      <PatternReports filters={filters} />
      <ProjectInsights />
      <LanguageFilter />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              ref={trigger}
              variant="ghost"
              size="icon"
              aria-label="Overview actions"
              title="Overview actions"
            />
          }
        >
          <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-max max-w-[calc(100vw-2rem)]">
          <DropdownMenuItem onClick={() => setDuplicating(true)}>
            Duplicate as dashboard
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DashboardNameDialog
        open={duplicating}
        onOpenChange={setDuplicating}
        title="Duplicate Overview"
        description="The copy keeps Overview's widgets as a dashboard your agent can change."
        initialName="Overview copy"
        submitLabel="Duplicate"
        build={overviewTemplate}
        finalFocus={trigger}
      />
    </>
  );
}
