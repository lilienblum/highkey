import { HugeiconsIcon } from "@hugeicons/react";
import { useRef, useState } from "react";
import {
  AndroidIcon,
  AppleIcon,
  CodeIcon,
  CommandLineIcon,
  ComputerIcon,
  CubeIcon,
  GameController03Icon,
  Globe02Icon,
  PackageIcon,
  ServerStack01Icon,
  SmartPhone01Icon,
} from "@hugeicons/core-free-icons";
import { resolveSourceIcon, sourceIcons, type SourceIconId } from "@/lib/source-icons";
import { Button } from "./ui/button";
import { FieldSet } from "./ui/field";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "./ui/popover";

const icons = {
  website: Globe02Icon,
  ios: AppleIcon,
  android: AndroidIcon,
  mobile: SmartPhone01Icon,
  terminal: CommandLineIcon,
  desktop: ComputerIcon,
  server: ServerStack01Icon,
  code: CodeIcon,
  package: PackageIcon,
  game: GameController03Icon,
  generic: CubeIcon,
};
export function SourceIcon({ name, icon }: { name: string; icon?: SourceIconId | null }) {
  const resolved = resolveSourceIcon({ name, icon });
  return (
    <HugeiconsIcon
      icon={icons[resolved]}
      strokeWidth={2}
      aria-hidden="true"
      data-source-icon={resolved}
    />
  );
}
export function SourceIconPicker({
  name,
  value,
  onChange,
  disabled,
}: {
  name: string;
  value: SourceIconId | null;
  onChange: (icon: SourceIconId | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = useRef<HTMLButtonElement>(null);
  const choices = useRef<(HTMLButtonElement | null)[]>([]);
  const automatic = resolveSourceIcon({ name });
  const label = sourceIcons.find(([id]) => id === (value ?? automatic))?.[1];
  function choose(icon: SourceIconId | null) {
    onChange(icon);
    setOpen(false);
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button variant="outline" size="icon" />}
        className="source-icon-trigger"
        aria-label={`Source icon: ${value ? label : `Automatic · ${label}`}`}
        title="Choose source icon"
        disabled={disabled}
      >
        <SourceIcon name={name} icon={value} />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 gap-3 p-3" initialFocus={selected}>
        <PopoverTitle>Source icon</PopoverTitle>
        <FieldSet className="grid grid-cols-4 gap-2" aria-label="Source icons">
          {sourceIcons.map(([id, title], index) => (
            <Button
              key={id}
              ref={(element) => {
                choices.current[index] = element;
                if (value === id) selected.current = element;
              }}
              type="button"
              variant="ghost"
              size="icon-lg"
              className="source-icon-choice"
              aria-label={title}
              title={title}
              aria-pressed={value === id}
              onClick={() => choose(id)}
              onKeyDown={(event) => {
                const next = {
                  ArrowLeft: index - 1,
                  ArrowRight: index + 1,
                  ArrowUp: index - 4,
                  ArrowDown: index + 4,
                  Home: 0,
                  End: sourceIcons.length - 1,
                }[event.key];
                if (next === undefined) return;
                event.preventDefault();
                choices.current[Math.max(0, Math.min(sourceIcons.length - 1, next))]?.focus();
              }}
            >
              <SourceIcon name="" icon={id} />
            </Button>
          ))}
        </FieldSet>
        <Button
          ref={value === null ? selected : undefined}
          type="button"
          variant="ghost"
          className="source-icon-choice w-full justify-start"
          aria-pressed={value === null}
          onClick={() => choose(null)}
        >
          <SourceIcon name={name} />
          Automatic
        </Button>
        <PopoverDescription>
          Automatic follows the source name. Icons only change its appearance.
        </PopoverDescription>
      </PopoverContent>
    </Popover>
  );
}
