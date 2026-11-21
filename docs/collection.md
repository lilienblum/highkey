# Collecting events

A project can combine multiple collectors: for example, Website, iOS app, and CLI. Each source gets separate write-only keys; the key sets both project and source on the server. Do not send `product_id` or `source_id` in the event envelope. The existing `source` string describes the client/transport and does not change attribution. UUID event IDs must be unique across all sources in a project.

For service logs, use [structured JSON or OTLP/HTTP collection](logs.md). Logs use separate `pl_` keys and storage; the SDKs below collect analytics events.

Identity remains optional and scoped to the project and identity kind. No person is automatically linked across web/mobile/tool sources. If you explicitly send the same opaque actor ID and identity kind from two sources, combined distinct-actor queries count it once. Use source-specific random IDs if that linkage is not intended. Visitor and installation identities remain distinct.

## Revenue and checkout

Use `properties.revenue` for integer cents, including zero and negative refunds. Keep one currency per project; Highkey does not perform currency conversion.

Create a secret server event key with `POST /api/products/:id/keys` and `{ "label": "Payments", "kind": "server" }`, or MCP `create_key` with `kind: "server"`. Store the returned `sk_…` secret on the backend:

```ts
const client = new Highkey({ endpoint: HIGHKEY_URL, key: SERVER_EVENT_KEY });
await client.send({
  event_id: paymentEventId, // Reuse for webhook retries.
  timestamp: paymentTimestamp,
  name: "purchase",
  source: "server",
  profile_id: userId,
  properties: { revenue: 2950, path: "/checkout", order_id: orderId },
});
```

Server keys reject browser requests. Public keys accept revenue only when an owner/admin explicitly enables it with `PATCH /api/products/:id/revenue/settings` and `{ "allow_browser_revenue": true }`.

In Project settings, choose **Secret server** under Ingestion keys for a backend key. The **Allow browser revenue** switch is off by default. MCP agents can use `update_revenue_settings` with the same `allow_browser_revenue` flag; read-only agents see the policy in `describe_project`.

In Explore, choose **Sum** and the `revenue` property to chart cents, then group by `path` or filter to a source. Agent-written dashboards use an event query with `{ "signal": "events", "measure": "sum", "property": "revenue" }`; divide by 100 in a formula when displaying currency units. Refund events subtract from the total.

Open **Revenue** in the project sidebar for exact net cents and revenue event counts. Group by source, page (`properties.path`), profile (`profile_id`), or session (`session_id`). Missing dimensions are shown as **Unattributed**; a zero-cent event is counted, while a missing `revenue` is not. Attribution uses the values on the payment or refund event. The report follows the selected source and date range.

Use `POST /api/read/products/:project/revenue/query` with a read API key, or call the `query_revenue` MCP tool. HTTP requires `from` and `to` as RFC 3339 timestamps. Both accept `group_by` (`source`, `page`, `profile`, `session`), `source_id`, `page` (starting at 1), and `page_size` (1–100). Results include `cents` as an exact decimal integer string, `revenue_events`, group count `groups`, and `rows` with `label`, `cents`, and `revenue_events`. Overall totals cover every group, including on later pages.

For that opted-in browser flow, call `tracker.beginCheckout(2950)` before navigating away, then `tracker.completeCheckout({ path: "/thanks" })` on the thank-you page. The first call stores only integer cents, an event ID and a 24-hour expiry in this tab's session storage; the second emits `purchase` through the usual filter and sanitizer. Failed delivery preserves the ID for a retry after reload; acknowledgment clears it. `cancelCheckout()` and `optOut()` discard it. Calls are refused while disabled, deferred, or blocked by privacy signals. Ordinary tracking never accesses checkout storage. Browser delivery is best effort; use server events for authoritative revenue and avoid sending both for the same purchase.

## AI generation events

Use the dependency-free wrappers with your existing provider SDK. They emit `ai_generation` with model, provider, reported token counts, latency, error/cancellation flags, and optional USD cost. Supply `trace_id` to correlate with application logs and `profile_id` or `groups` for attribution.

To include a call in an existing visit's timeline, use its source key and explicitly pass `visit: { actor_id, session_id }`. The wrappers never create either ID.

```ts
import { trackOpenAI, trackAnthropic, trackVercelAI, vercelAIHooks } from "@highkey/sdk/ai";

const options = { source: "server", model: "your-model", trace_id: requestTraceId };
const response = await trackOpenAI(client, options, () =>
  openai.responses.create({ model: options.model, input: prompt }),
);
const message = await trackAnthropic(client, options, () =>
  anthropic.messages.create({ model: options.model, max_tokens: 1024, messages }),
);
const generated = await trackVercelAI(client, options, () => generateText({ model, prompt }));
// AI SDK streaming uses callbacks and never drains the stream for telemetry:
const streamed = streamText({ model, prompt, ...vercelAIHooks(client, options) });
```

OpenAI Responses, Chat Completions and Anthropic `messages.create({stream:true})` streams are tracked when consumed with `for await`. Chunks pass through untouched; an early break closes the source and records cancellation. For streamed Chat Completions, request `stream_options: {include_usage: true}` to receive token counts. Helper methods that consume provider streams internally are outside this iterator wrapper; use the provider's raw async iterator.

Vercel hooks support `onFinish` and `onEnd` completion names, plus `onError`/`onAbort`. If you already use these callbacks, call both your callback and the corresponding hook. Each hook set records once. Nonstreaming `trackVercelAI` uses total usage across steps when available.

No prompts, generated text, or error messages are collected automatically. To retain a prompt, pass both `capturePrompt: true` and `prompt`; text is bounded to 32 KiB at a Unicode boundary, hidden from readers after 30 days, and erased by ClickHouse TTL. Numeric metrics follow normal project retention. `cost` may be an explicit USD amount or a function of the reported token counts; omitted or unavailable costs stay absent, never guessed from model names. Anthropic cached-read and cache-write input counts are separate from uncached input.

Provider results and thrown errors are preserved even if collection fails. Completion waits for the collection client's bounded delivery deadline (800 ms by default). Use a shorter client timeout for latency-sensitive paths.

## Profiles and groups

Identity remains opt-in. Use an opaque application ID rather than an email as the profile ID:

```ts
await client.identify({
  source: "server",
  profile_id: "user-123",
  traits: { plan: "pro", active: true },
  increments: { credits: -1 },
});
await client.group({
  source: "server",
  group_type: "team",
  group_id: "team-456",
  group_name: "Engineering",
  traits: { seats: 8 },
});
await client.send({
  source: "server",
  name: "build",
  profile_id: "user-123",
  groups: { team: "team-456" },
});
```

The browser tracker exposes `identify(id, traits?, increments?)`, `group(type, id, traits?, name?, increments?)` and `reset()`. Accepted identify/group calls attach that profile/group to subsequent events in memory; `reset()` clears them at logout. They use the same filter and sanitizer as ordinary events. Deferred trackers reject explicit identity calls until `ready()`. Nothing is persisted to the browser unless persistent visitor identity was separately enabled.

Rust uses `Event::identify("server", "user-123").trait_value("plan", "pro").increment("credits", -1.0)` and `Event::group("server", "team", "team-456")`.

Traits retain scalar types. Each mutation's sets happen before its increments, and negative increments decrement. Reuse the event ID when retrying an application operation so it cannot increment twice. Profile/group records are excluded from ordinary analytics event counts.

## JavaScript and TypeScript SDK

Use the [`@highkey/sdk` package](../sdk/typescript/README.md) in a website, Bun tool, or server. It ships JavaScript and TypeScript declarations with no runtime dependencies. The package guide covers local installation until registry publication. Existing source imports from `sdk/typescript/client.ts` also remain supported. Create a project (an organization's first project is created on `/new`, with a source and that source's ingestion key) and choose or add a source in Settings, then create an ingestion key for that source. Use only source-scoped ingestion keys in collectors; management access remains separate. For websites, use the browser tracker below to apply privacy signals and opt-out behavior. The generic client sends explicit calls and does not manage collection preferences.

```ts
import { Highkey } from "@highkey/sdk";
const highkey = new Highkey({
  endpoint: "https://highkey.example.com",
  key: "pk_...",
  timeoutMs: 800,
  retries: 1,
});
await highkey.send({
  name: "purchase",
  source: "server",
  properties: { amount: 29.5, paid: true, currency: "USD" },
});
```

`sendBatch` accepts 1–100 events. IDs and timestamps are materialized once before retrying, preserving deduplication. The total request deadline includes retries and backoff. Redirects are refused, cookies and Referer are omitted, and an optional `signal` cancels delivery. 400/401/413/422 are not retried; retryable network/server failures and 429 get at most one retry by default. A 429's Retry-After longer than the remaining deadline ends delivery immediately; a 5xx's is shortened to half of what remains, so the one retry still happens. Awaited sends return durable acknowledgment or throw a delivery error; catch errors if analytics must not fail your business operation.

## Browser tracker

Bundled applications can import `startBrowserTracker` from `@highkey/sdk/browser`. The hosted module remains available without installing a package:

```html
<script type="module" referrerpolicy="no-referrer">
  import { startBrowserTracker } from "https://highkey.example.com/tracker.js";
  const tracker = startBrowserTracker({
    endpoint: "https://highkey.example.com",
    key: "pk_...",
    identity: "none",
  });
  tracker.track("signup", { plan: "pro", seats: 3, trial: true });
</script>
```

Start the tracker only when your application's collection preference permits it. `enabled: false` returns an inert tracker: no automatic events, history hooks, timers, or identity storage. Highkey treats Do Not Track (`navigator.doNotTrack === "1"`) and Global Privacy Control (`navigator.globalPrivacyControl === true`) as do-not-collect signals. They cannot be overridden. An absent signal is not a user's consent decision.

The hosted ESM module supports cross-origin import. The script's `referrerpolicy="no-referrer"` prevents the module request and its imports from carrying the embedding page's URL. For bundled or dynamically loaded integrations, configure the host page's Referrer-Policy too. The ingestion client independently omits Referer and cookies and refuses redirects.

The tracker sends `page_view` initially and after changed `pushState`, `replaceState`, or `popstate` navigation. Automatic properties contain the pathname and referrer hostname (or `Direct`). By default it excludes page titles, query strings, fragments, and full referrer URLs. Campaign capture is **off by default**. To collect reviewed campaign labels, opt in with an explicit list such as `campaigns: ["utm_source", "utm_medium", "utm_campaign"]`. The five supported names are `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, and `utm_content`; only listed parameters are copied.

For reviewed page titles, set `collectTitle: true`. Each page view includes the current `document.title` as `title`, limited to 512 UTF-16 code units. Titles are read when the event is collected; if your router sets the title later, set it before navigation or send a manual `pageView()` after updating it.

For hash-based routes, set `trackHashChanges: true`. The fragment becomes part of `path` (for example `/app#/settings`), and hash changes produce page views. Back/Forward navigation emits one view even when the browser fires both `popstate` and `hashchange`. The URL's query string is still excluded, but the opted-in fragment is passed in full to `sanitizePath`: remove sensitive values, including any query-like values inside the fragment. Both options default to false and still obey DNT/GPC, opt-out, and `beforeSend`.

### Click events

`trackOutboundLinks: true` collects a `link_out` event when someone clicks an HTTP(S) link to another origin, including keyboard and middle-click activation. It sends `url` (origin and pathname only, without credentials, query or fragment) and `text` (trimmed link text), each limited to 512 UTF-16 code units. Internal links, email links and other protocols are ignored. The tracker never cancels or delays navigation.

`trackAttributes: true` collects clicks on elements you explicitly mark:

```html
<button data-track="signup" data-plan="pro" data-seats="3">Sign up</button>
```

This sends `signup` with `{ plan: "pro", seats: "3" }`. Values remain strings; dataset keys use the browser's camelCase convention. The nearest marked element supplies the event, including clicks on its children and inside open shadow roots. Up to 32 valid property names are collected, with values limited to 512 UTF-16 code units. Invalid event names are ignored. This does not read form values.

Both click options are off by default. They use the same bounded queue, privacy signals and `beforeSend` filter as other events. Review destination paths, link text and `data-*` attributes before enabling them. An outgoing link marked with `data-track` produces both events when both options are enabled.

Paths, hostnames, campaign labels, and custom properties can still contain personal data. Prefer static route patterns and bounded product categories. Configure these controls before starting collection:

```ts
const tracker = startBrowserTracker({
  endpoint: "https://highkey.example.com",
  key: "pk_...",
  collectReferrer: false,
  sanitizePath: (path) => (path.startsWith("/users/") ? "/users/:id" : null),
  beforeSend(event) {
    if (event.name === "page_view") return event;
    if (event.name !== "signup") return null;
    return { ...event, properties: { trial: event.properties?.trial === true } };
  },
});
```

`sanitizePath` receives the pathname, with the fragment appended only when `trackHashChanges` is enabled; returning `null` omits the path. `collectReferrer: false` omits the referrer. `beforeSend` runs synchronously for automatic and custom events before they enter the queue, including opted-in titles. Return a sanitized event or `null` to drop it. A thrown sanitizer error drops the event. Accepted scalar properties are copied so later mutation does not change queued data. These are explicit collection policies, not automatic personal-data detection.

Identity defaults to **`none`**, with no visitor/session IDs or identifier storage. To measure visitors and sessions, explicitly set `identity: "persistent"` and `identityScope: "YOUR_PRODUCT_ID"` after your application's privacy decision. This creates a random, **pseudonymous** visitor ID in localStorage, scoped by collector origin and scope (the ingestion key if omitted). Using the product ID preserves this identifier through key rotation. A random session ID rolls after 30 minutes of inactivity. Tabs share storage best-effort and may race session creation. Storage denial falls back to unidentified events, with no fingerprint fallback. Do not use emails or account names as IDs.

On withdrawal, call `tracker.optOut()`. It stops collection, removes hooks/timers, discards queued events, aborts delivery, and removes only this tracker's stored visitor/session IDs. It cannot undo a request already received by the server. The host application must persist the user's choice and avoid starting another enabled tracker on reload. A later explicit opt-in requires a new tracker instance. Privacy signals are also checked before collecting and flushing, so a newly observed opt-out discards pending events.

The pending queue holds 100 events, sends batches of up to 20 (targeting 60 KiB of JSON), and flushes every two seconds. Full queues drop new events. Delivery uses keepalive fetch for bodies up to 64 KiB and ordinary fetch for larger bodies, with a short total deadline. Ordinary fetch cannot outlive page unload, and browser shutdown may lose events. `flush()` attempts one bounded batch. `shutdown()` stops collection and drains queued batches within one total `timeoutMs` deadline (800 ms by default), discarding anything still pending at the deadline. Neither guarantees delivery. `shutdown()` is a normal lifecycle flush; use **`optOut()`** for privacy withdrawal. Install only one tracker instance per page.

### Shared properties and deferred delivery

Set `properties: { app_version: "1.2" }` to attach reviewed properties to every event. Event-specific values override them. `tracker.setProperties({...})` replaces the shared properties for future events; queued events keep their original values. `filter: event => boolean` rejects unwanted events before `beforeSend`; a thrown filter error also drops the event.

`defer: true` keeps accepted events in the same bounded, in-memory queue until `tracker.ready()` enables delivery. No visitor/session storage is read or written before `ready()`, and queued events are not retroactively identified. DNT/GPC and `enabled: false` remain absolute collection blocks. `flush()` and unload cannot send a deferred queue; shutting down or opting out before readiness discards it.

Use deferred delivery only when your application's policy permits collecting in memory while waiting. For no collection before permission, keep `enabled: false` or wait to create the tracker. Calling `ready()` cannot revive an opted-out, disabled, or shut-down tracker.

## Rust SDK

Use the standalone [`highkey-sdk` crate](../sdk/rust/README.md) for new Rust integrations. It uses reqwest/rustls, Tokio, serde/serde_json, uuid, and chrono; it has no dependency on Highkey's server or databases.

```rust
use highkey_sdk::{Event, Highkey};

let client = Highkey::new("https://highkey.example.com", "pk_YOUR_SOURCE_KEY")?;
let event = Event::new("command_run", "cli")
    .property("command", "build")
    .property("success", true)
    .property("duration_ms", 42_u64);
let ack = client.send(&event).await?;
```

Run on a Tokio runtime and send only after your application's collection preference permits it. `Event::new` captures a UUID and timestamp once, without an actor or installation identity. `send_batch` accepts 1–100 events within 256 KiB. A send returns the committed acknowledgment or a typed error. The default 800 ms total deadline includes retries, response reads, and backoff; dropping the future cancels pending delivery. Use `Highkey::with_options` to adjust the deadline and retry count. Reuse the original event when retrying in your application.

`sdk/rust/examples/collect.rs` demonstrates the public SDK with explicit opt-in and `DO_NOT_TRACK` handling:

```sh
HIGHKEY_TELEMETRY=1 HIGHKEY_ENDPOINT=http://127.0.0.1:3001 \
HIGHKEY_INGESTION_KEY=pk_YOUR_KEY cargo run -p highkey-sdk --example collect
```

## Rust CLI example

`sdk/rust/examples/cli.rs` reports each command a CLI runs, on the SDK's bounded delivery: 800 ms in all (`HIGHKEY_TELEMETRY_TIMEOUT_MS`, 1–5000), retries included, and a failed send never fails the command.

```sh
HIGHKEY_TELEMETRY=1 \
HIGHKEY_ENDPOINT=http://127.0.0.1:3000 \
HIGHKEY_INGESTION_KEY=pk_YOUR_KEY \
cargo run -p highkey-sdk --example cli -- build
```

The example sends only when `HIGHKEY_TELEMETRY=1`, an endpoint, and a key are configured. `DO_NOT_TRACK=1` disables collection even when enabled. Try `-- fail` to report failure and exit nonzero. Events carry `command`, app `version`, `os`, `arch`, boolean `success`, and numeric `duration_ms`. Command labels are restricted to `build`, `fail`, `check`, `init`, `dev`, and `deploy`; other arguments are reported as `other`. The example does not create an installation ID automatically. Set `HIGHKEY_INSTALLATION_ID` only to an optional random ID chosen under your application’s telemetry preference. To measure installations, generate one random ID once and store it in your application's configuration directory only with the user's chosen telemetry setting. Do not send usernames, machine names, arguments, filesystem paths, or command output by default.

The example runs its command first, then sends one event with the SDK's `send`, through `Highkey::with_options` and the configured deadline. The SDK refuses redirects, retries once with the original ID and timestamp, honors Retry-After within the remaining deadline (a 5xx's longer delay is shortened to half of what remains), and gives up when the deadline expires. The example ignores the send's result, so analytics failure never changes the CLI result or delays exit beyond that deadline.

To exercise the actual Rust example and verify its stored types locally, run `bun scripts/verify-cli.ts` while Highkey is running at `HIGHKEY_API_URL` (default `http://127.0.0.1:3000`, as under `bun run dev:standalone`), with `HIGHKEY_API_KEY` set to a write API key of an organization owner or admin. It creates a small **Rust CLI example** project visible in the dashboard.

## Mobile / HTTP collectors

Create a mobile source and use its key with `POST /api/ingest`, from a native app's HTTP client or any other SDK. No device identifier or advertising ID is needed. For example:

```json
{
  "event_id": "GENERATE_ONE_UUID_PER_EVENT",
  "name": "screen_view",
  "source": "ios",
  "properties": { "screen": "home", "version": "2.1.0", "subscribed": false }
}
```

Supply `Authorization: Bearer pk_...` and `Content-Type: application/json`. Replace the example event ID with a real UUID. Set an explicit HTTP deadline, retain the exact envelope for bounded retries, and only send after your app's collection preference permits it. For retries, include the original UTC RFC3339 `timestamp` too. The server's 200 response acknowledges persistence. These are HTTP integration examples, not native Swift/Kotlin SDKs; see [retry and validation semantics](api.md#ingestion).
