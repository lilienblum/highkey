// A server that stops the way the dashboard does, for shutdown.test.ts.
import { stopOnSignals } from "../../shutdown";

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/slow") await Bun.sleep(500);
    if (path === "/hang") await new Promise(() => {});
    return new Response("done");
  },
});
stopOnSignals(server, { graceMs: 1_000 });
console.log(server.port);
