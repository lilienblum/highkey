import type { RefObject } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  DocumentError,
  createDashboard,
  type DashboardDocument,
  type StoredDashboard,
} from "@/lib/dashboards";
import { workspaceTarget } from "@/lib/workspace-route";
import { useWorkspace } from "../app-shell";
import { NameDialog } from "../name-dialog";

/** Opens a dashboard that was just created, after the sidebar has learned about it. */
export function useOpenDashboard() {
  const navigate = useNavigate();
  const { product, reload } = useWorkspace();
  return async (stored: StoredDashboard) => {
    await reload();
    if (product) await navigate(workspaceTarget("/dashboards", product.slug, stored.slug));
  };
}

/** A failed create reads as the API's first complaint about the document, else the error itself. */
export function createErrorMessage(error: unknown): string {
  if (error instanceof DocumentError && error.issues[0]) return error.issues[0].message;
  return error instanceof Error ? error.message : "Could not create the dashboard.";
}

/** Names a copy of a dashboard and opens it. */
export function DashboardNameDialog({
  build,
  ...props
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  initialName: string;
  submitLabel: string;
  /** The document to save under the chosen name. */
  build: (name: string) => DashboardDocument;
  finalFocus?: RefObject<HTMLElement | null>;
}) {
  const { product } = useWorkspace();
  const open = useOpenDashboard();
  return (
    <NameDialog
      {...props}
      onSubmit={async (name) => {
        if (!product) throw new Error("Choose a project first.");
        let stored: StoredDashboard;
        try {
          stored = await createDashboard(product.id, build(name));
        } catch (error) {
          throw new Error(createErrorMessage(error));
        }
        // The dialog closes first, so the opened page owns focus.
        props.onOpenChange(false);
        await open(stored);
      }}
    />
  );
}
