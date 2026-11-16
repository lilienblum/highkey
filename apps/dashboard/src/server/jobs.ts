// Background work: reconcile the key registry, project access and retention changes at start
// and every minute. The first successful run after a start re-creates every project's access.
import type { ApiContext } from "./api/context";
import { reconcile } from "./registry";

export const RECONCILE_EVERY_MS = 60_000;

export function startJobs(ctx: ApiContext): () => void {
  let running = false;
  let full = true;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await reconcile(ctx, { full });
      full = false;
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
