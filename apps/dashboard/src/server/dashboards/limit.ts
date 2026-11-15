// Per-project limit on dashboard and view writes, so an agent loop cannot hammer the API. A
// sliding window in memory; state is per process and lost on restart, which is fine for a
// politeness limit.

export const MAX_WRITES = 30;
export const WINDOW_MS = 60_000;
const SWEEP_AT = 1024;

export class WriteLimit {
  private readonly seen = new Map<string, number[]>();

  constructor(
    private readonly max = MAX_WRITES,
    private readonly window = WINDOW_MS,
  ) {}

  /** Records a write, or returns the whole seconds (at least 1) to wait. */
  take(project: string, now = Date.now()): number | null {
    if (this.seen.size > SWEEP_AT)
      for (const [key, at] of this.seen)
        if (!at.length || now - (at.at(-1) as number) >= this.window) this.seen.delete(key);
    const at = this.seen.get(project) ?? [];
    while (at.length && now - (at[0] as number) >= this.window) at.shift();
    if (at.length >= this.max)
      return Math.max(1, Math.ceil((this.window - (now - (at[0] as number))) / 1000));
    at.push(now);
    this.seen.set(project, at);
    return null;
  }
}
