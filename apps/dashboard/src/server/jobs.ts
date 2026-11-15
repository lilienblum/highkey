// Background work: reconcile the key registry and project access at start and every minute.
import type { ApiContext } from "./api/context";
import { reconcile } from "./registry";

export const RECONCILE_EVERY_MS = 60_000;

export function startJobs(ctx: ApiContext): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await reconcile(ctx);
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
