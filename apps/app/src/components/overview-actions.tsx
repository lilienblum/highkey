import { useRef, useState, type RefObject } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { overviewTemplate } from "@/lib/dashboards";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { DashboardNameDialog } from "./dashboards/new-dashboard-dialog";
import { ProjectInsights } from "./insights";
import { LanguageFilter } from "./language-filter";
import { PatternReportsDialog } from "./pattern-reports";

export type ReportDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  finalFocus?: RefObject<HTMLElement | null>;
};

export function OverviewActions({ filters }: { filters: Record<string, unknown> }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [action, setAction] = useState<"patterns" | "insights" | "filter" | "duplicate" | null>(
    null,
  );
  const close = () => setAction(null);
  return (
    <>
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
          <DropdownMenuItem onClick={() => setAction("patterns")}>
            Activity patterns
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setAction("insights")}>
            Significant changes
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setAction("filter")}>Describe a filter</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setAction("duplicate")}>
            Duplicate as dashboard
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <PatternReportsDialog
        filters={filters}
        open={action === "patterns"}
        onOpenChange={close}
        finalFocus={trigger}
      />
      <ProjectInsights open={action === "insights"} onOpenChange={close} finalFocus={trigger} />
      <LanguageFilter open={action === "filter"} onOpenChange={close} finalFocus={trigger} />
      <DashboardNameDialog
        open={action === "duplicate"}
        onOpenChange={close}
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
