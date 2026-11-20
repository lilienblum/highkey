// Background work without Tako (`dev:standalone`, a plain `bun` server): the reconcile that the
// `reconcile` Tako workflow runs every minute under Tako, on an in-process timer instead.
import type { ApiContext } from "./api/context";
import { reconcileOnce } from "./registry";

export const RECONCILE_EVERY_MS = 60_000;

/** Whether Tako runs this process, and with it the scheduled workflows. */
export function underTako(): boolean {
  return Boolean(process.env.TAKO_APP_NAME);
}

export function startJobs(ctx: ApiContext): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await reconcileOnce(ctx);
    } catch (error) {
      console.warn("Reconcile failed; retrying in a minute", error);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(tick, RECONCILE_EVERY_MS);
  return () => clearInterval(timer);
}
