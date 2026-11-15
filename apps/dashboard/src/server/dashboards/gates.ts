// Concurrency gates for dashboard widget runs, so dashboards never take the last query slot an
// interactive page needs. A run waits at a gate until its own deadline.

export class Semaphore {
  private waiting: (() => void)[] = [];
  constructor(private available: number) {}

  /** Waits for `n` permits until `deadline` (epoch ms); resolves to a release, or null on timeout. */
  async acquire(deadline: number, n = 1): Promise<(() => void) | null> {
    for (;;) {
      if (this.available >= n) {
        this.available -= n;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.available += n;
          for (const wake of this.waiting.splice(0)) wake();
        };
      }
      const left = deadline - Date.now();
      if (left <= 0) return null;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiting.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

export interface Gates {
  events: Semaphore;
  logs: Semaphore;
}

/** `PIKO_QUERY_CONCURRENCY` (1–16, default 4): dashboards may use all but one event slot. */
export function gatesFromEnv(env: Record<string, string | undefined> = process.env): Gates {
  const n = Number(env.PIKO_QUERY_CONCURRENCY ?? 4);
  const slots = Number.isInteger(n) && n >= 1 && n <= 16 ? n : 4;
  return { events: new Semaphore(Math.max(1, slots - 1)), logs: new Semaphore(1) };
}
