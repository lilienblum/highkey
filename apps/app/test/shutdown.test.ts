import { describe, expect, test } from "bun:test";

const fixture = new URL("./fixtures/shutdown-server.ts", import.meta.url).pathname;

async function start() {
  const child = Bun.spawn(["bun", fixture], { stdout: "pipe", stderr: "inherit" });
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  const port = Number(new TextDecoder().decode(value).trim());
  return { child, url: `http://127.0.0.1:${port}` };
}

async function exited(child: ReturnType<typeof Bun.spawn>, withinMs: number) {
  const timeout = Bun.sleep(withinMs).then(() => "still running" as const);
  return Promise.race([child.exited.then(() => "exited" as const), timeout]);
}

describe("shutdown", () => {
  test("a_stop_signal_finishes_in_flight_requests_and_exits_cleanly", async () => {
    const { child, url } = await start();
    const slow = fetch(`${url}/slow`).then((response) => response.text());
    await Bun.sleep(100);
    child.kill("SIGTERM");
    expect(await slow).toBe("done");
    expect(await exited(child, 3_000)).toBe("exited");
    expect(child.signalCode).toBeNull();
    expect(child.exitCode).toBe(0);
  });

  test("a_request_that_never_finishes_does_not_hold_the_exit", async () => {
    const { child, url } = await start();
    fetch(`${url}/hang`).catch(() => {});
    await Bun.sleep(100);
    child.kill("SIGTERM");
    expect(await exited(child, 3_000)).toBe("exited");
    expect(child.exitCode).toBe(0);
  });
});
