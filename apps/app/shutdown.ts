// Stops the server on SIGTERM or SIGINT: it stops accepting connections, lets requests in flight
// finish, and exits, so an update or restart does not cut off requests. (Bun as a container's
// PID 1 would otherwise ignore SIGTERM entirely.)

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
