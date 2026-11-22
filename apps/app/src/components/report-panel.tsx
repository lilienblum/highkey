import type { ReactNode } from "react";
import { Button } from "./ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./ui/sheet";

/** A report tool opens beside its page and returns focus to its own button. */
export function ReportPanel({
  title,
  label = title,
  description,
  wide,
  open,
  onOpenChange,
  children,
}: {
  title: string;
  label?: string;
  description: string;
  wide?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger render={<Button variant="outline" size="sm" />}>{label}</SheetTrigger>
      <SheetContent className={`w-full gap-0 ${wide ? "sm:max-w-3xl" : "sm:max-w-xl"}`}>
        <SheetHeader className="shrink-0 border-b px-4 py-5 pr-14 sm:pl-6">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        <div className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-4 overflow-y-auto overscroll-contain p-4 sm:p-6">
          {children}
        </div>
      </SheetContent>
    </Sheet>
  );
}
