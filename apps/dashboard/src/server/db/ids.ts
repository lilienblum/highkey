// Timestamps and ids for management rows.

export function now(): string {
  return new Date().toISOString();
}

/** A time-ordered id (UUIDv7). */
export function newId(): string {
  return Bun.randomUUIDv7();
}
