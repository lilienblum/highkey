// The server entry: the TanStack Start handler, plus what the API needs once per process. Live
// change hints for writes made here go to the same channel the ingest app's webhook feeds, and
// the key registry and project access are reconciled at start and every minute.
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { apiContext, setChangeBus } from "./server/api/context";
import { startJobs } from "./server/jobs";
import { publishChange } from "./server/realtime";

const started = globalThis as { highkeyJobs?: boolean };
if (!started.highkeyJobs) {
  started.highkeyJobs = true;
  setChangeBus({ notify: publishChange });
  startJobs(apiContext());
}

export default createServerEntry({
  fetch(request, opts) {
    return handler.fetch(request, opts);
  },
});
