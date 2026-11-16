// Stops the server on SIGTERM or SIGINT: it stops accepting connections, lets requests in flight
// finish, and exits. In a container Bun runs as PID 1, which ignores a signal it has no handler
// for, so without this `docker stop` waits out its grace period and then kills the process.

interface Stoppable {
  stop(closeActiveConnections?: boolean): Promise<void>;
}

/** Installs the handlers. A request still running after `graceMs` is cut off. */
export function stopOnSignals(server: Stoppable, options: { graceMs?: number } = {}): void {
  const graceMs = options.graceMs ?? 8_000;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const deadline = Bun.sleep(graceMs).then(() => server.stop(true));
    await Promise.race([server.stop(), deadline]);
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
