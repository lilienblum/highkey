import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type Ref,
  type RefObject,
} from "react";
import { useBlocker } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  Alert02Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Copy01Icon,
  Delete02Icon,
  DragDropVerticalIcon,
  PencilEdit02Icon,
  SourceCodeIcon,
} from "@hugeicons/core-free-icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  listRevisions,
  resolvedSize,
  SIZE_PRESETS,
  type RevisionInfo,
  type Size,
  type Widget,
} from "@/lib/dashboards";

const icon = { strokeWidth: 2, "aria-hidden": true } as const;

/**
 * The sticky bar under the heading while a dashboard is edited: what state the draft is in, the
 * ways to add to it, and Cancel and Save. Add widget and Edit JSON are disabled until wired.
 */
export function EditBar({
  dirty,
  saving,
  onSave,
  onCancel,
  onAddWidget,
  onEditJson,
  saveDisabled = false,
  ref,
}: {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
  onAddWidget?: () => void;
  onEditJson?: () => void;
  /** Save also waits while a conflict needs a choice. */
  saveDisabled?: boolean;
  ref?: Ref<HTMLElement>;
}) {
  const unavailable = useId();
  return (
    <section ref={ref} tabIndex={-1} className="dashboard-edit-bar" aria-label="Edit dashboard">
      <p className="dashboard-edit-state" data-dirty={dirty || undefined}>
        {dirty ? "Unsaved changes" : "Editing layout"}
      </p>
      <div className="dashboard-edit-actions">
        <Button
          variant="ghost"
          size="sm"
          disabled={!onAddWidget}
          focusableWhenDisabled
          aria-describedby={onAddWidget ? undefined : unavailable}
          onClick={onAddWidget}
        >
          <HugeiconsIcon icon={Add01Icon} {...icon} data-icon="inline-start" />
          Add widget
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!onEditJson}
          focusableWhenDisabled
          aria-describedby={onEditJson ? undefined : unavailable}
          onClick={onEditJson}
        >
          <HugeiconsIcon icon={SourceCodeIcon} {...icon} data-icon="inline-start" />
          Edit JSON
        </Button>
        {(!onAddWidget || !onEditJson) && (
          <span id={unavailable} hidden>
            Not available yet
          </span>
        )}
        <Button variant="outline" size="sm" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={!dirty || saving || saveDisabled} onClick={onSave}>
          {saving && <Spinner data-icon="inline-start" aria-hidden="true" />}
          Save
        </Button>
      </div>
    </section>
  );
}

const sizeKey = (size: Size) => `${size.w}x${size.h}`;
/** The API's widget limit per dashboard (spec §6). */
const MAX_WIDGETS = 24;

/**
 * One widget's controls in edit mode: a drag handle (pointer) with Move earlier and Move later
 * (keyboard), its size, and Edit, Duplicate and Remove. Remove asks inline, in place of the row.
 * Move buttons at either end stay focusable, so focus never drops after the last move.
 */
export function WidgetEditControls({
  widget,
  index,
  count,
  onMove,
  onResize,
  onEdit,
  onDuplicate,
  onRemove,
}: {
  widget: Widget;
  index: number;
  count: number;
  onMove: (delta: number) => void;
  onResize: (size: Size) => void;
  onEdit?: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const keep = useRef<HTMLButtonElement>(null);
  const remove = useRef<HTMLButtonElement>(null);
  const returning = useRef(false);
  useEffect(() => {
    if (confirming) keep.current?.focus();
    else if (returning.current) remove.current?.focus();
    returning.current = false;
  }, [confirming]);
  const cancel = () => {
    returning.current = true;
    setConfirming(false);
  };

  if (confirming)
    return (
      <fieldset
        // Distinct keys keep the two rows from reusing each other's buttons (and transitions).
        key="confirm"
        aria-label={`Remove ${widget.title}?`}
        className="widget-edit-controls"
        data-confirming=""
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          cancel();
        }}
      >
        <span className="widget-edit-question">Remove this widget?</span>
        <span className="widget-edit-actions">
          <Button ref={keep} variant="ghost" size="xs" onClick={cancel}>
            Keep
          </Button>
          <Button variant="destructive" size="xs" onClick={onRemove}>
            Remove widget
          </Button>
        </span>
      </fieldset>
    );

  const size = resolvedSize(widget);
  const preset = SIZE_PRESETS.find((p) => sizeKey(p.size) === sizeKey(size));
  const options = [
    ...SIZE_PRESETS.map((p) => ({ value: sizeKey(p.size), label: p.label, size: p.size })),
    // A size no preset names (an AI may write 4×1) stays selectable as itself.
    ...(preset ? [] : [{ value: sizeKey(size), label: `${size.w}×${size.h}`, size }]),
  ];
  const current = options.find((option) => option.value === sizeKey(size));
  const full = count >= MAX_WIDGETS;
  return (
    <fieldset key="arrange" aria-label={`Arrange ${widget.title}`} className="widget-edit-controls">
      <span
        className="widget-drag-handle"
        data-drag-handle=""
        draggable
        title="Drag to reorder"
        aria-hidden="true"
      >
        <HugeiconsIcon icon={DragDropVerticalIcon} strokeWidth={2} />
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Move earlier"
        title="Move earlier"
        data-edit-control="earlier"
        disabled={index === 0}
        focusableWhenDisabled
        onClick={() => onMove(-1)}
      >
        <HugeiconsIcon icon={ArrowLeft01Icon} {...icon} />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Move later"
        title="Move later"
        data-edit-control="later"
        disabled={index >= count - 1}
        focusableWhenDisabled
        onClick={() => onMove(1)}
      >
        <HugeiconsIcon icon={ArrowRight01Icon} {...icon} />
      </Button>
      <Select
        // A value picker must not remove the page scrollbar.
        modal={false}
        items={options.map(({ value, label }) => ({ value, label }))}
        value={sizeKey(size)}
        onValueChange={(next) => {
          const option = options.find((o) => o.value === next);
          if (option && option.value !== sizeKey(size)) onResize(option.size);
        }}
      >
        <SelectTrigger size="sm" aria-label="Size" className="widget-size-trigger">
          <SelectValue>{current?.label}</SelectValue>
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false} align="start">
          <SelectGroup>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
                {option.label !== `${option.size.w}×${option.size.h}` && (
                  <span className="widget-size-hint" aria-hidden="true">
                    {option.size.w}×{option.size.h}
                  </span>
                )}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <span className="widget-edit-actions">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Edit widget"
          title="Edit widget"
          disabled={!onEdit}
          onClick={onEdit}
        >
          <HugeiconsIcon icon={PencilEdit02Icon} {...icon} />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Duplicate"
          title={full ? `A dashboard holds at most ${MAX_WIDGETS} widgets` : "Duplicate"}
          data-edit-control="duplicate"
          disabled={full}
          onClick={onDuplicate}
        >
          <HugeiconsIcon icon={Copy01Icon} {...icon} />
        </Button>
        <Button
          ref={remove}
          variant="ghost"
          size="icon-xs"
          aria-label="Remove"
          title="Remove"
          data-edit-control="remove"
          onClick={() => setConfirming(true)}
        >
          <HugeiconsIcon icon={Delete02Icon} {...icon} />
        </Button>
      </span>
    </fieldset>
  );
}

type Drop = { id: string; side: "before" | "after"; style: CSSProperties };
const DRAG_TYPE = "application/x-piko-widget";

/**
 * Pointer reordering by HTML drag and drop. Only a widget's handle starts a drag; the grid shows
 * where the widget will land between its neighbours: left or right of a card that shares its row,
 * above or below one that fills the row. `onMove` gets the same delta Move earlier/later use.
 */
export function useWidgetDrag(
  grid: RefObject<HTMLElement | null>,
  ids: string[],
  onMove: (id: string, delta: number) => void,
) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const end = useCallback(() => {
    setDragging(null);
    setDrop(null);
  }, []);
  const onDragStart = (event: DragEvent<HTMLElement>) => {
    const target = event.target;
    const card =
      target instanceof Element
        ? target.closest("[data-drag-handle]")?.closest<HTMLElement>("[data-widget]")
        : null;
    const id = card?.dataset.widget;
    if (!card || !id) return;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(DRAG_TYPE, id);
    const box = card.getBoundingClientRect();
    event.dataTransfer.setDragImage(card, event.clientX - box.left, event.clientY - box.top);
    setDragging(id);
  };
  // Entering a card places the indicator at once (browsers send dragover only on the next update);
  // cancelling both events is what accepts the drop.
  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if (!dragging || !grid.current) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const card =
      event.target instanceof Element ? event.target.closest<HTMLElement>("[data-widget]") : null;
    // Gaps between cards keep the last position, so the indicator does not flicker.
    if (!card) return;
    const id = card.dataset.widget;
    if (!id || id === dragging) {
      if (drop) setDrop(null);
      return;
    }
    const area = grid.current.getBoundingClientRect();
    const box = card.getBoundingClientRect();
    const gap = Number.parseFloat(getComputedStyle(grid.current).columnGap) || 0;
    const fills = box.width >= area.width - 1;
    const side: Drop["side"] = (
      fills
        ? event.clientY < box.top + box.height / 2
        : event.clientX < box.left + box.width / 2
    )
      ? "before"
      : "after";
    if (drop?.id === id && drop.side === side) return;
    const style: CSSProperties = fills
      ? {
          left: box.left - area.left,
          top: (side === "before" ? box.top - gap / 2 : box.bottom + gap / 2) - area.top - 1,
          width: box.width,
          height: 2,
        }
      : {
          left: (side === "before" ? box.left - gap / 2 : box.right + gap / 2) - area.left - 1,
          top: box.top - area.top,
          width: 2,
          height: box.height,
        };
    setDrop({ id, side, style });
  };
  const onDragLeave = (event: DragEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !grid.current?.contains(next)) setDrop(null);
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    if (!dragging) return;
    event.preventDefault();
    if (drop) {
      const from = ids.indexOf(dragging);
      const over = ids.indexOf(drop.id);
      let to = over + (drop.side === "after" ? 1 : 0);
      if (to > from) to--;
      if (from >= 0 && over >= 0 && to !== from) onMove(dragging, to - from);
    }
    end();
  };
  return {
    dragging,
    gridProps: {
      onDragStart,
      onDragEnter: onDragOver,
      onDragOver,
      onDragLeave,
      onDrop,
      onDragEnd: end,
    },
    indicator: drop ? (
      <div className="dashboard-drop-indicator" aria-hidden="true" style={drop.style} />
    ) : null,
  };
}

const changedBy: Record<RevisionInfo["origin"], string> = {
  api: "Changed by API",
  mcp: "Changed by MCP",
  dashboard: "Changed in Piko",
};

/** "just now", "3 min ago", "2 hours ago", "4 days ago". */
export function relativeTime(iso: string, now: number): string {
  // The API writes nanoseconds; Date parsing wants at most milliseconds.
  const at = Date.parse(iso.replace(/(\.\d{3})\d+/, "$1"));
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/**
 * The dashboard changed elsewhere while it was being edited. Who changed it comes from the
 * revision list; the banner waits for it so it is announced once, with its final text.
 */
export function ConflictBanner({
  project,
  dashboard,
  revision,
  busy,
  onLoadTheirs,
  onKeepMine,
}: {
  project: string;
  dashboard: string;
  revision: number;
  busy: boolean;
  onLoadTheirs: () => void;
  onKeepMine: () => void;
}) {
  const revisions = useQuery({
    queryKey: ["dashboard-revisions", project, dashboard, revision],
    queryFn: ({ signal }) => listRevisions(project, dashboard, signal),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  if (revisions.isPending) return null;
  const change =
    revisions.data?.find((entry) => entry.revision === revision) ?? revisions.data?.[0];
  const title = change
    ? `${changedBy[change.origin]} ${relativeTime(change.created_at, Date.now())}`.trim()
    : "Changed elsewhere";
  return (
    <Alert className="dashboard-conflict">
      <HugeiconsIcon icon={Alert02Icon} {...icon} />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>
          This dashboard has a newer version than the one you are editing. Load it and lose your
          changes, or keep yours and save them over it.
        </p>
        <div className="dashboard-conflict-actions">
          <Button variant="outline" size="sm" disabled={busy} onClick={onLoadTheirs}>
            Load their version
          </Button>
          <Button size="sm" disabled={busy} onClick={onKeepMine}>
            Keep mine
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

/**
 * Asks before an in-app navigation to another page drops unsaved changes. Range, source and other
 * search changes stay on the dashboard and keep the draft, so they pass without asking; closing
 * or reloading the tab gets the browser's own prompt.
 */
export function UnsavedChangesGuard({ dirty }: { dirty: boolean }) {
  const shouldBlockFn = useCallback(
    ({ current, next }: { current: { pathname: string }; next: { pathname: string } }) =>
      current.pathname !== next.pathname,
    [],
  );
  const blocker = useBlocker({ shouldBlockFn, withResolver: true, disabled: !dirty });
  return (
    <AlertDialog
      open={blocker.status === "blocked"}
      onOpenChange={(open) => {
        if (!open) blocker.reset?.();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
          <AlertDialogDescription>
            Your edits to this dashboard have not been saved. Leaving discards them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep editing</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => blocker.proceed?.()}>
            Discard changes
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
