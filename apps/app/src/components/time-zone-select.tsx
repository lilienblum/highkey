import { Combobox } from "@base-ui/react/combobox";
import { ArrowDown01Icon, Search01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo } from "react";

const label = (zone: string) => zone.replaceAll("_", " ");

function offsetOf(zone: string) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "shortOffset",
    }).formatToParts(new Date());
    return (parts.find((part) => part.type === "timeZoneName")?.value ?? "").replace("GMT", "UTC");
  } catch {
    return "";
  }
}

/**
 * Searchable timezone picker: a select-style trigger whose popup holds a filter field and a short,
 * scrollable list. Offsets are a visual hint only, so option names stay the IANA zone.
 */
export function TimeZoneSelect({
  id,
  label: name,
  value,
  zones,
  onValueChange,
}: {
  id?: string;
  label: string;
  value: string;
  zones: readonly string[];
  onValueChange: (zone: string) => void;
}) {
  const offsets = useMemo(() => new Map(zones.map((zone) => [zone, offsetOf(zone)])), [zones]);
  return (
    <Combobox.Root
      items={zones}
      value={value}
      itemToStringLabel={label}
      onValueChange={(next) => {
        if (next) onValueChange(next);
      }}
    >
      <Combobox.Trigger
        id={id}
        aria-label={name}
        data-slot="select-trigger"
        className="flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-surface-inset px-3 py-2 text-sm whitespace-nowrap text-foreground outline-none disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Combobox.Value>
          {(zone: string | null) => <span className="truncate">{zone ? label(zone) : ""}</span>}
        </Combobox.Value>
        <span data-slot="select-icon">
          <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} className="size-4" />
        </span>
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner align="start" sideOffset={4} className="isolate z-50">
          <Combobox.Popup
            data-slot="select-content"
            className="time-zone-popup w-(--anchor-width) min-w-64 text-popover-foreground data-closed:animate-out data-closed:fade-out-0"
          >
            <div className="time-zone-search">
              <HugeiconsIcon icon={Search01Icon} strokeWidth={2} aria-hidden="true" />
              <Combobox.Input placeholder="Search timezones" aria-label="Search timezones" />
            </div>
            <Combobox.Empty className="time-zone-empty">No matching timezone</Combobox.Empty>
            <Combobox.List className="time-zone-list">
              {(zone: string) => (
                <Combobox.Item
                  key={zone}
                  value={zone}
                  data-slot="select-item"
                  className="relative flex w-full cursor-default items-center gap-2 py-2 pr-8 text-sm outline-hidden select-none"
                >
                  <span className="truncate">{label(zone)}</span>
                  <span className="time-zone-offset" aria-hidden="true">
                    {offsets.get(zone)}
                  </span>
                  <Combobox.ItemIndicator
                    data-slot="select-item-indicator"
                    className="pointer-events-none absolute right-2 flex size-4 items-center justify-center"
                  >
                    <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} />
                  </Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
