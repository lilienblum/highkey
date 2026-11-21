# Native Tako applications

Highkey runs as two native Tako apps: `tako.ingest.toml` runs the ingest app as `highkey-ingest`, and `tako.app.toml` runs the app as `highkey`. Both need a ClickHouse server: locally `bun dev` starts one in Docker; in production you run your own.

Highkey uses the published Rust SDK for the ingest app and the JavaScript SDK for TanStack Start. The ingest app has no dashboard imports: it can optionally emit generic post-commit change hints to a configured HTTP endpoint. The dashboard turns those hints, and its own writes, into an ephemeral Tako channel. The JavaScript SDK is pinned to `0.0.0-419336e`. The matching published CLI supports both ordinary development and `bun run test:e2e`, which uses `tako dev --env test-e2e`.

## Local development

```sh
bun install --frozen-lockfile
bun dev
NODE_USE_SYSTEM_CA=0 SSL_CERT_FILE=.tako/dev-ca.pem HIGHKEY_API_URL=https://highkey.test bun seed
# Stop only these two apps; ClickHouse keeps running:
bun run dev:stop
# Remove the local ClickHouse container (its volume stays):
bun scripts/clickhouse.ts dev-down
```

`bun dev` does four things:

1. It links Tako's local CA at `.tako/dev-ca.pem` and creates the shared development `HIGHKEY_CHANGE_TOKEN` if absent.
2. It starts ClickHouse in Docker with `bun scripts/clickhouse.ts dev-up`: the pinned image as container `highkey-dev-clickhouse`, published only on `127.0.0.1:8123`, with its data in the `highkey-dev-clickhouse` volume. It migrates the server on every start.
3. It builds the SDK, including the tracker bundle `sdk/typescript/dist/tracker.js`, which the ingest app serves.
4. It starts the ingest app at `https://highkey-ingest.test` (`cargo run -p highkey-ingest`) and the dashboard at `https://highkey.test`.

The development ClickHouse passwords are fixed in each config's `[vars.development]`; they protect nothing but the local server. The dashboard forwards the ingest paths and `/tracker.js` to `HIGHKEY_INGEST_URL` (`https://highkey-ingest.test`), so collectors and `bun seed` can use `https://highkey.test` alone.

If the checkout moved and Docker cannot mount `deploy/clickhouse/.../highkey.xml`, run `bun scripts/clickhouse.ts dev-down`, then `bun dev`. This replaces the container and its obsolete bind mounts while reusing the named `highkey-dev-clickhouse` data volume.

The app’s generic error page shows a stable support code; look it up in `errkit.json`. If a local workspace load fails with `no such column` after pulling migrations, restart the dashboard from the main checkout with `tako -c tako.app.toml dev --restart --background`. This applies pending migrations to the existing development database. Generate the TypeScript error catalog with `bun run errors:generate` after adding entries; keep assigned codes unchanged.

If `tako dev list --json` reports a daemon protocol mismatch after a CLI upgrade, run `tako -c tako.ingest.toml dev --restart --background` to replace the old daemon, then `bun dev` to bring both apps up. Replacing the daemon stops other local apps it manages; restart those from their projects. The E2E runner never requests a daemon upgrade.

The returned Tako HTTPS URLs are the supported development entrypoints. The runner links the public local Tako CA at `.tako/dev-ca.pem`; development-only `SSL_CERT_FILE` settings let Bun and Rust verify it even when their default trust stores differ from macOS. The dashboard also sets `NODE_USE_SYSTEM_CA=0` so Bun trusts only that file: stale certificates with the same "Tako Development CA" name in the system keychain otherwise cause `CERT_SIGNATURE_FAILURE`. Bun versions that ignore `NODE_USE_SYSTEM_CA` still verify the CA when it is also given as `NODE_EXTRA_CA_CERTS=.tako/dev-ca.pem`, which the dashboard and the browser tests set too. Use the same variables for `bun seed` and other local Bun clients, or delete the stale keychain entries. Certificate verification stays enabled.

The development runner creates a random shared `HIGHKEY_CHANGE_TOKEN` through the CLI's stdin interface if absent. Both configs share the repository's encrypted `.tako/secrets.json`. Never commit that directory or print the secret. Runtime code obtains it from SDK secrets, not browser environment variables. A token rotation requires restarting both apps.

The dashboard keeps its management state (projects, sources, key hashes, settings, dashboards, views) in a Tako database bound as `main` and named `highkey`. Under `tako dev`, Tako serves it from `.tako/data/databases/highkey.sqlite` and applies the numbered files in `migrations/` to it before the app starts and whenever one changes. The minute reconcile (key registry, project access, pending retention changes) runs as the `reconcile` Tako workflow in a separate worker. Events and logs live in ClickHouse's volume. The ingest app has no state.

Before this change the dashboard kept a `state.sqlite` file under `$TAKO_DATA_DIR` (locally `.tako/data/app`). Tako does not move it: to keep local projects, import that file into the development database (`tako sqlite import highkey .tako/data/app/state.sqlite` with the dev apps stopped).

`bun run dev:standalone` runs the same stack without Tako: the development ClickHouse, the ingest app at http://127.0.0.1:3001 and the dashboard at http://127.0.0.1:3000, with the management state in a plain SQLite file, `./data/state.sqlite` (or under `HIGHKEY_DATA_DIR`), to which the dashboard applies `migrations/` itself and records them the way Tako does. Without Tako the reconcile runs on a timer inside the dashboard. Standalone mode refreshes automatically every 30 seconds while visible and online, and on focus/reconnect, without a channel connection.

## Realtime semantics

1. The ingest app validates and batches ingestion, writes to ClickHouse, and acknowledges only after ClickHouse has stored the rows. Duplicate-only retries emit no change hint.
2. A bounded broadcast buffer holds up to 128 hints. A background worker coalesces them per project over 250 ms, with at most 64 projects per message. Overflow becomes a global resync hint.
3. The ingest app POSTs `{ "version": 2, "changes": [{ "product": "<uuid>", "signals": ["events"] }] }` to `HIGHKEY_CHANGE_URL`, using the shared bearer secret. `changes: null` means resync everything. Each attempt has an 800 ms deadline; failures retry a global hint with backoff capped at 30 seconds. Startup emits a global hint. Delivery never delays ingestion acknowledgments.
4. Dashboard, view, project, source and key writes in the dashboard publish a `dashboards` hint directly, without the webhook.
5. `POST /_highkey/changes` validates the secret, content type, an 8 KiB body limit, UUIDs, and the version (1 or 2). It publishes a `changed` message on `analytics-changes` and acknowledges only when channel publication succeeds.
6. One receive-only browser connection serves the workspace. Messages contain no event payloads, properties, names, or credentials. The selected project scopes refresh behavior in the client. Channel parameters are **not** used as a security partition.

The channel declares `ephemeral: true`: hints stay in memory, have no replay cursor, and never enter a channel message database. Only currently connected subscribers on the same Tako server receive them. The runtime buffers at most 64 messages per active channel; slow subscribers may miss evicted hints. Messages sent without subscribers or during a disconnect are lost, and restarting the server discards the buffer. See [Tako's channel semantics](https://github.com/tako-sh/tako/blob/9ae824f876ea74456ed695b1cb5efb577735e960/website/docs/channels.mdx).

The ingest app's hint queue is also bounded and is **not a durable event outbox**. Stored events and ingestion acknowledgments remain durable. Notifications invalidate queries rather than represent events. On every connection, including the first, Overview and Events query current state automatically. Restart/global hints, returning to the tab, network recovery, and periodic reconciliation recover missed changes. A connected client can temporarily show stale data until the next successful query; channel delivery is not a correctness boundary for stored analytics. Retention deletes rows during ClickHouse merges and sends no hint.

Overview and Events update automatically after commit hints. They retain existing results and charts, coalesce bursts, and allow one query batch in flight plus one pending update. Window focus, tab visibility, and network recovery trigger reconciliation; a 30-second visible/online check covers lost ephemeral hints and standalone mode. Hidden or offline tabs pause automatic refreshes. There is no manual refresh button or connection-status chrome.

Events reruns the applied query without submitting draft edits or resetting the page. An open inspector keeps the records it opened with, including adjacent-event navigation. The table itself remains a live, newest-first offset page; new events can change its rows and page count. Fixed drilldown dates remain fixed and still receive late-arriving events. Background requests do not disable query or pagination controls.

Each analytical request has a 15-second deadline. Queries retry a short server-advertised capacity delay once, then transient failures get up to three automatic retries at 1/2/4 seconds; longer outages are retried by the regular reconciliation. Existing results remain visible with an error until recovery. Changing scope cancels requests and pending retries. Management mutations are never automatically retried.

## Production and updates

Production needs a ClickHouse server, version 25.8 or newer, which you install on the host; the ingest app refuses older servers at startup. Development and tests run `clickhouse/clickhouse-server:26.8.37.168` (pinned in `scripts/clickhouse.ts`), so prefer that release line.

### ClickHouse on the server

1. Install ClickHouse from its [official packages](https://clickhouse.com/docs/install). The packaged server listens only on localhost; keep it that way when both apps run on the same host, and never expose it to the Internet.
2. Copy Highkey's server settings into place: `deploy/clickhouse/config.d/highkey.xml` to `/etc/clickhouse-server/config.d/highkey.xml`, and `deploy/clickhouse/users.d/highkey.xml` to `/etc/clickhouse-server/users.d/highkey.xml`. They turn on the access-control checks that keep projects apart, the JSON key escaping Highkey's properties rely on, and small-server memory settings.
3. Create the admin user the dashboard and the migrations sign in as (`highkey_admin` unless `HIGHKEY_CLICKHOUSE_USER` names another), in `/etc/clickhouse-server/users.d/highkey-admin.xml`. It needs access management, which lets it create each project's reader user, views and grants:

   ```xml
   <clickhouse>
       <users>
           <highkey_admin>
               <!-- printf '%s' "$HIGHKEY_CLICKHOUSE_PASSWORD" | sha256sum -->
               <password_sha256_hex>…</password_sha256_hex>
               <networks><ip>127.0.0.1</ip><ip>::1</ip></networks>
               <profile>default</profile>
               <quota>default</quota>
               <access_management>1</access_management>
               <named_collection_control>1</named_collection_control>
           </highkey_admin>
       </users>
   </clickhouse>
   ```

4. Restart ClickHouse (`sudo systemctl restart clickhouse-server`), then run the migrations below. They create the `highkey_ingest` user; every project's reader is created by the dashboard.

A server set up this way, with only these three files, passed the same checks as the development server: the migrations applied, a project reader read its own views and was refused the shared tables, and the ingest user read the contract.

Run the migrations from a checkout of the release you are deploying, before the first start and before every update, with `HIGHKEY_CLICKHOUSE_URL`, the admin `HIGHKEY_CLICKHOUSE_PASSWORD` and `HIGHKEY_INGEST_CLICKHOUSE_PASSWORD` set in the environment:

```sh
bun run migrate
```

It creates or upgrades the tables, views, settings profiles and the `highkey_ingest` user, whose password it sets to `HIGHKEY_INGEST_CLICKHOUSE_PASSWORD`. The ingest app refuses to start against a schema older than it needs, and says to run `bun run migrate`.

The checked-in configs deliberately contain no production hostnames or servers. Add your selected environment to each config, for example:

```toml
# tako.ingest.toml
[envs.production]
route = "highkey-ingest.example.com"
servers = ["your-server"]

[vars.production]
HIGHKEY_CLICKHOUSE_URL = "http://127.0.0.1:8123"
HIGHKEY_CHANGE_URL = "https://highkey.example.com/_highkey/changes"
HIGHKEY_TRACKER_PATH = "sdk/typescript/dist/tracker.js"
```

```toml
# tako.app.toml
[envs.production]
route = "highkey.example.com"
servers = ["your-server"]
network = "<your network id>"
databases = { main = "highkey" }
backup = { storage = "private_backups" }

[vars.production]
HIGHKEY_PUBLIC_URL = "https://highkey.example.com"
HIGHKEY_CLICKHOUSE_URL = "http://127.0.0.1:8123"
HIGHKEY_INGEST_URL = "https://highkey-ingest.example.com"
# HIGHKEY_SIGNUP = "invite"  # optional: restrict signup to invited people after the first account
```

The Tako database needs a network (`tako network` commands) and is created once on the server that will hold it: `tako sqlite create highkey --server your-server`. `backup.storage` names a private S3-compatible storage resource (`[storages.private_backups]`, with credentials set by `tako storages credentials private_backups --env production`) that receives the database's encrypted snapshots; without one, Tako takes no snapshots and losing the server loses the management state. Tako applies `migrations/` on every deploy, after a snapshot and before the new release starts.

Set `HIGHKEY_CHANGE_TOKEN` for production through `tako -c tako.app.toml secrets set HIGHKEY_CHANGE_TOKEN --env production`; the two root configs share this secret store. Set `BETTER_AUTH_SECRET` the same way, to a long random value: it signs sessions, and changing it signs everyone out. Email and social sign-in are optional secrets too: `HIGHKEY_RESEND_API_KEY` and `HIGHKEY_EMAIL_FROM`, `HIGHKEY_GITHUB_CLIENT_ID` and `HIGHKEY_GITHUB_CLIENT_SECRET`, `HIGHKEY_GOOGLE_CLIENT_ID` and `HIGHKEY_GOOGLE_CLIENT_SECRET` (see [accounts](access.md#accounts)). `HIGHKEY_READER_SECRET`, which derives each project's ClickHouse reader password, is optional and read only by the app; it defaults to the admin password.

Set both ClickHouse passwords as secrets in the shared store: `HIGHKEY_CLICKHOUSE_PASSWORD` (the admin user, which only the dashboard uses) and `HIGHKEY_INGEST_CLICKHOUSE_PASSWORD` (the `highkey_ingest` user: the dashboard's migration sets it, and the ingest app reads it before the generic name):

```sh
tako -c tako.app.toml secrets set HIGHKEY_CLICKHOUSE_PASSWORD --env production
tako -c tako.app.toml secrets set HIGHKEY_INGEST_CLICKHOUSE_PASSWORD --env production
```

The ingest host serves only the ingest paths, `/tracker.js` and `/health`. It needs no other protection: its paths take only ingestion keys; see [the network boundary](access.md#network-boundary). Collectors can send to either host: the dashboard forwards the ingest paths to `HIGHKEY_INGEST_URL`.

Use one server, one ingest instance and one dashboard instance. The dashboard's ephemeral channel also requires all subscribers and publishers to share that Tako server process. Do not configure a shared `postgres_url` credential: Tako currently rejects ephemeral subscriptions and publications in that mode. The native Rust build must run on Linux with the target server's architecture and libc; a macOS binary is not a deployment artifact. Tako does not cross-compile Rust for this config. The ingest build also builds the tracker bundle with Bun. Build/deploy the two configs **sequentially** because their local staging directory is shared. Deployment artifacts contain the compiled apps and the tracker, not local databases.

To update:

1. Run `bun run migrate` against the production ClickHouse from the new release. Migrations only add, so the running apps keep working.
2. Deploy the ingest app with `tako -c tako.ingest.toml deploy --env production`. It holds no state, so Tako's normal rolling replacement works. While the old and new processes overlap, a retry that reaches the other process can be stored twice until a merge removes it (see [deduplication](api.md#deduplication)).
3. Deploy the app with `tako -c tako.app.toml deploy --env production`. Tako applies any new file in `migrations/` first (they only add, so the running release keeps working), then replaces the app and its workflow worker. Old and new instances share the hosted database while they overlap.

Do not delete an app to deploy an update; deletion can remove persistent data. No production deployment is performed by local setup. After the first deploy, open the dashboard and create the first account: it administers the server.

## Backups and restore

Back up two things: ClickHouse's `highkey` database, which holds events, logs and the key registry, and the dashboard's Tako database `highkey`, which holds projects, sources, key hashes, settings, dashboards, views and pending retention changes. The rest of ClickHouse's Highkey state is rebuilt: `bun run migrate` creates the schema, settings profiles and shared users, and from the management database the `reconcile` workflow recreates whatever project access is missing every minute (all of it after a release changes it) and rewrites the key registry. Take the ClickHouse backup close to a database snapshot, and store both with restricted access.

### ClickHouse

Back up the `highkey` database as the admin user (`clickhouse-client --user highkey_admin --password`) to S3 or S3-compatible storage, with a new path for every backup:

```sql
BACKUP DATABASE highkey
TO S3('https://your-bucket.s3.amazonaws.com/highkey/2026-11-19', '<key id>', '<key secret>');
```

Restore onto a fresh server set up as above: run `bun run migrate` first, so the schema and users exist, then restore the two data tables, which are still empty:

```sql
RESTORE TABLE highkey.events, TABLE highkey.logs
FROM S3('https://your-bucket.s3.amazonaws.com/highkey/2026-11-19', '<key id>', '<key secret>');
```

`RESTORE` refuses tables that already hold rows, so do not restore into a server that has been ingesting. Restore the management database next, then start the apps.

### The management database

With a backup storage configured, Tako snapshots the `highkey` database every hour while it changes, before each deploy's migrations, and on demand (`tako sqlite backup highkey`); snapshots are consistent copies, checked, compressed and encrypted, and kept for 24 hours, then daily for a week and weekly for four weeks. Recovery is to a snapshot, so up to an hour of management changes can be lost with the server.

```sh
tako sqlite backups highkey --json
tako sqlite restore highkey --latest
tako sqlite export highkey ./highkey-state.sqlite
```

A snapshot holds key hashes and display prefixes, never key secrets. A restore pauses the database briefly (requests get 503) and keeps the contents it replaced as a snapshot of its own. The next reconcile rewrites the key registry from the restored database. Keys created after the snapshot are not in it, but their registry rows stay in ClickHouse, so they keep authorizing ingestion until those rows are removed from `highkey.ingest_keys`. Events of a project the snapshot does not hold stay stored, but no page shows them.

Local development and each deployed environment have separate storage; selecting another config does not copy data. To move an installation, take both backups, restore them on the new server as above, and check projects, keys, queries and duplicate retries before pointing collectors at it.

## Verification boundaries

`cargo test` runs the ingest app against a real ClickHouse: the contract and server-version checks, keys and their cache, origins, validation, deduplication, OTLP, retention by event time, capacity, and change hints. `bun run test` runs the SDK and script tests and the dashboard server tests against the same disposable ClickHouse: management, queries, dashboards, views, MCP, migrations, the key registry and the isolation between projects. Browser tests run through `bun run test:e2e` using dedicated Tako hosts and a disposable ClickHouse; they never target the preview. `bun run test:load` checks ingestion latency under heavy dashboard load. [Verification](verification.md) records the checks actually run; [the benchmark](benchmark.md) measures the ingest app, the dashboard's API and ClickHouse on loopback, excluding the channel bridge, TLS, and the edge.

## Browser tests

Run `bun run test:e2e`, optionally followed by Playwright file filters or flags, with a Tako CLI supporting `dev --env`. It starts a fresh ClickHouse for the run (`highkey-e2e-clickhouse`, in memory, on `127.0.0.1:18124`), builds the tracker, and starts `tako.ingest.toml` and `tako.app.toml` with `dev --env test-e2e`. Their `[envs.test-e2e]` and `[vars.test-e2e]` sections set the test routes, credentials and notification URL. The runner creates fresh `HIGHKEY_CHANGE_TOKEN` and `BETTER_AUTH_SECRET` secrets only for that environment. Test hosts are stable (`highkey-test-e2e.test`, `highkey-ingest-test-e2e.test`); Tako isolates app data and the migrated `highkey-test-e2e` database under `.tako/data/envs/test-e2e/`. The preview's database, ingestion keys, and projects are never used. The first addition of test TLS names may reload Tako's local daemon; the runner restores previously registered apps with their selected environments before testing and during teardown.

Normal completion, test failures, Ctrl-C, and SIGTERM stop the test apps and remove the run's ClickHouse before deleting their data. If stopping an app fails, its data is retained and the command fails instead of deleting an open database. A hard kill or machine shutdown cannot run teardown: after confirming no test run is active, inspect `tako dev list --env test-e2e --json`, then run `tako -c tako.app.toml dev stop --env test-e2e` and `tako -c tako.ingest.toml dev stop --env test-e2e`, and remove `.tako/e2e/runner.lock`. The next run replaces leftover test data and the `highkey-e2e-clickhouse` container itself. Do not remove `.tako/data/`, which also holds the preview.
