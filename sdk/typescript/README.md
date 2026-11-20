# Highkey JavaScript SDK

`@highkey/sdk` collects events from JavaScript and TypeScript with **zero runtime dependencies**. It ships ESM JavaScript and TypeScript declarations, plus an optional browser tracker at `@highkey/sdk/browser`. It uses native `fetch`, Web Crypto, and AbortSignal APIs: use Bun 1.4+, Node.js 22+, or a current browser. Browser collection requires a secure context (HTTPS or localhost).

## Install from this checkout

The package is not published to a registry yet. From the repository root:

```sh
bun install --frozen-lockfile
bun run build:sdk
cd sdk/typescript
bun pm pack --destination /tmp
# In your application, install the tarball printed by the command:
bun add /tmp/highkey-sdk-0.1.0.tgz
```

The tarball includes compiled JavaScript, declarations, the README, and the MIT license; consumers do not need TypeScript or Bun to run it.

## Send events

```js
import { Highkey, DeliveryError } from "@highkey/sdk";

const highkey = new Highkey({
  endpoint: "https://highkey.example.com",
  key: "pk_YOUR_SOURCE_KEY",
  timeoutMs: 800,
  retries: 1,
});

try {
  const ack = await highkey.send({
    name: "purchase",
    source: "server",
    properties: { amount: 29.5, paid: true, currency: "USD" },
  });
  console.log(ack.accepted, ack.duplicates);
} catch (error) {
  // Decide whether analytics failure should affect your application.
  if (error instanceof DeliveryError) console.warn(error.status);
}
```

`endpoint` is the collector base URL, optionally with a path prefix; the SDK appends `/api/ingest`. Use HTTPS in production. The source-scoped public ingestion key determines project and source attribution; `source` is a client/transport label. No management credentials are needed.

`sendBatch(events)` accepts 1–100 events within the API's 256 KiB JSON limit. Event properties are flat strings, finite numbers, or booleans. Missing `event_id` and `timestamp` are generated once per send and retained through all internal retries. Supply both explicitly when retrying the same event in a later call. The API validates names, property sizes, identities, and retention.

Successful sends return `{ accepted, duplicates }` after the API commits. Invalid acknowledgments throw. Network errors, HTTP 429, and HTTP 5xx may retry; other HTTP errors do not. The 800 ms default deadline includes network work, response reading, and backoff. Numeric `Retry-After` delays cannot extend it: a 429's delay is honoured or ends delivery, and a 5xx's delay that outlasts the deadline is shortened to half of what remains, so the retry still happens. Redirects are refused, and cookies and referrers are omitted. Pass an `AbortSignal` as `signal` to cancel a send. A timeout may occur after server commit; reuse the same event ID to deduplicate retries.

## Browser collection

AI provider wrappers are available from `@highkey/sdk/ai`: `trackOpenAI`, `trackAnthropic`, `trackVercelAI`, and streaming `vercelAIHooks`. They preserve provider results and errors while recording token usage, latency, optional USD cost, and trace/profile attribution. Prompt retention requires explicit opt-in. See the collection guide for usage and streaming behavior.

`highkey.identify({source, profile_id, traits?, increments?})` updates an explicit profile. `highkey.group({source, group_type, group_id, group_name?, traits?, increments?})` updates a group. Negative increments decrement; sets happen first. Ordinary events can carry `profile_id` and `groups: {team: "team-id"}`. Mutation records share event deduplication but do not count as analytics events.

```js
import { startBrowserTracker } from "@highkey/sdk/browser";

// Start only after your application's collection preference allows it.
const tracker = startBrowserTracker({
  endpoint: "https://highkey.example.com",
  key: "pk_YOUR_WEBSITE_SOURCE_KEY",
  identity: "none",
  collectReferrer: false,
});
tracker.track("signup", { plan: "pro", trial: true });
// On privacy withdrawal:
tracker.optOut();
```

The tracker honors DNT/GPC, collects no identity or campaign parameters by default, and has a bounded queue. It tracks the initial page and SPA history navigation. Optional `collectTitle: true` adds the current page title (at most 512 UTF-16 code units); `trackHashChanges: true` includes the fragment in `path` and tracks hash navigation. Both are off by default. Configure `sanitizePath` (which receives the fragment too when enabled) and `beforeSend` to exclude sensitive data. `optOut()` discards queued data and aborts delivery; `shutdown()` attempts to drain within one deadline. `flush()` attempts one batch and is best effort. The generic `Highkey` client sends explicit calls and does not manage consent.

Opt-in click collection supports `trackOutboundLinks: true` (`link_out` events with a stripped destination URL and link text) and `trackAttributes: true` (`data-track` event names with other dataset values as string properties). Both obey the same privacy controls and leave navigation alone.

Use `properties` and `tracker.setProperties()` for shared properties, and `filter` for an event predicate before `beforeSend`. `defer: true` queues in memory without delivery or identity storage until `tracker.ready()`; opting out or shutting down first discards that queue. `enabled: false` still means no collection.

Explicit `tracker.identify(id, traits?, increments?)` and `tracker.group(type, id, traits?, name?, increments?)` attach that profile/group to later events in memory. Use `tracker.reset()` at logout to clear them. These calls obey privacy signals, filtering and sanitization, and are refused while deferred. They do not enable persistent visitor storage.

See [the collection guide](https://github.com/lilienblum/highkey/blob/v0/docs/collection.md) for identity, lifecycle, privacy controls, and the hosted `/tracker.js` option.
