# Docker Compose

Piko supports Compose alongside [native Tako](tako.md). One `compose.yaml` serves standalone Docker Compose and a Tako Compose group. Standalone Compose has no live channel: Overview and Events refresh every 30 seconds while visible and online, and on focus/reconnect. No notification secret is needed.

`compose.yaml` builds two targets from the root Dockerfile and runs four services:

| Service      | What it is                                                                 | Storage                                    | Reachable at                                   |
| ------------ | -------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------- |
| `clickhouse` | The pinned `clickhouse/clickhouse-server` image, with Piko's server config | `piko-clickhouse` at `/var/lib/clickhouse` | `http://clickhouse:8123`, Compose network only |
| `migrate`    | A one-shot job in the dashboard image: `bun run migrate`, then it exits    | None                                       | Not a server                                   |
| `ingest`     | The Rust ingest app: ingestion and `/tracker.js`                           | None                                       | `http://ingest:3001`, Compose network only     |
| `dashboard`  | The Bun dashboard: the UI and every other `/api` path                      | `piko-data` at `/data` (`state.sqlite`)    | `127.0.0.1:${PIKO_PORT:-3000}` on the host     |

They start in order: ClickHouse becomes healthy, `migrate` creates or upgrades the tables, views and users and exits, the ingest app becomes healthy, then the dashboard starts. Only the dashboard publishes a port. It forwards `/api/ingest`, `/api/logs/ingest`, `/api/logs/v1/logs` and `/tracker.js` to `http://ingest:3001` and serves everything else itself. Keep one ingest replica, because exact deduplication relies on it, and one dashboard replica, because `state.sqlite` has one owner.

## Run with Docker Compose

Install Docker Engine with the Compose plugin, or Docker Desktop/OrbStack locally. Compose requires two passwords: `PIKO_CLICKHOUSE_PASSWORD` for ClickHouse's admin user, which the dashboard and `migrate` use, and `PIKO_INGEST_CLICKHOUSE_PASSWORD` for the ingest app's `piko_ingest` user, which `migrate` creates. Put them in a `.env` file beside `compose.yaml`; Compose reads it automatically, and Git and the Docker build ignore it. Create it once, from the repository root (the `printf` line overwrites an existing `.env`):

```sh
printf 'PIKO_CLICKHOUSE_PASSWORD=%s\nPIKO_INGEST_CLICKHOUSE_PASSWORD=%s\n' \
  "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" > .env
docker compose up --build -d
docker compose ps
```

Open http://127.0.0.1:3000. Builds run inside Linux containers; local Bun and Rust toolchains are unnecessary for this option. Keep `.env` with the installation: every later Compose command needs the same values. Optional settings in `.env` are `PIKO_PORT` (default 3000) and `PIKO_CLICKHOUSE_MEMORY` (default `4g`; see [ClickHouse memory](#clickhouse-memory)).

Use `docker compose logs --tail 100` to inspect startup. After source changes, rerun `docker compose up --build -d`; the Rust build stage copies only the ingest app's sources, so a dashboard-only change reuses the cached ingest image. Stop with `docker compose down`, which retains the named volumes. Do not add `--volumes` when retaining data. The Compose project name determines which volumes are used; keep it stable for an existing installation.

`bun scripts/compose-smoke.ts` (needs Bun) builds and starts a separate `piko-smoke` project with fresh passwords, sends one event through the dashboard's forwarding, waits for Explore to count it, and removes the project and its volumes.

Protect the dashboard with Cloudflare Tunnel and Access before exposing it. Only the three ingest paths and `/tracker.js` receive public Access bypasses; see [the access boundary](access.md#compose-ingress).

## Cloudflare Tunnel

Point the Tunnel's hostname at the dashboard: `http://127.0.0.1:3000` when `cloudflared` runs on the host, or `http://dashboard:3000` when it runs on the Compose network. The dashboard's forwarding then covers ingestion and the tracker.

To keep ingestion and the tracker independent of the dashboard, so they stay up while it restarts, add path rules that send the ingest paths and `/tracker.js` straight to the ingest container. The ingest port is not published, so this needs `cloudflared` on the Compose network, for example as an extra service in a `compose.override.yaml`. A locally managed tunnel's `config.yml`:

```yaml
ingress:
  - hostname: piko.example.com
    path: ^/(api/ingest|api/logs/ingest|api/logs/v1/logs|tracker\.js)$
    service: http://ingest:3001
  - hostname: piko.example.com
    service: http://dashboard:3000
  - service: http_status:404
```

Rules apply in order, and the path is a regular expression; anchor it so nothing else reaches the ingest app. The ingest app serves only those paths and `/health` either way. The Access policies are the same for both setups.

## CORS for read-only pages

The dashboard allows cross-origin requests to `/api/read/*` from loopback origins by default. To let a page served elsewhere read it, set `PIKO_CORS_ORIGINS` on the dashboard service: a comma-separated list of exact origins (scheme, host and port; no trailing slash and no path). `null` is never allowed, and `*` is accepted by the code but should not be used. Add it to the `dashboard` service's `environment` in `compose.yaml`:

```yaml
services:
  dashboard:
    environment:
      PIKO_CORS_ORIGINS: "https://wall.example.com,http://192.168.1.20:8080"
```

Recreate the dashboard with `docker compose up -d dashboard`. The restart briefly interrupts the UI and any ingestion the dashboard forwards; see [updates](#updates-and-recovery). See [local pages](dashboards.md#local-pages) and [access](access.md#local-pages-and-cors) for what the allowlist covers and the Access settings it needs. Native Tako sets it under `[vars.production]` in `tako.dashboard.toml`.

## ClickHouse memory

`PIKO_CLICKHOUSE_MEMORY` sets the ClickHouse container's memory limit, `4g` by default. The reference host is an 8 GB server that runs ClickHouse at that default beside the ingest app, the dashboard and the operating system. On a smaller host, lower it in `.env`, for example `PIKO_CLICKHOUSE_MEMORY=2g`, and recreate with `docker compose up -d`.

Piko's server config (`deploy/clickhouse/config.d/piko.xml`, mounted read-only) keeps ClickHouse inside that limit: the server uses at most 90% of it, the mark caches are small, the uncompressed cache is off, the background pool has four threads, and most system log tables are off; `query_log` is kept for seven days to diagnose slow widgets. Each project's queries are capped separately at 1 GiB of memory, 2 threads and 10 seconds, so one heavy dashboard query fails on its own rather than starving the host. If ClickHouse reaches its server limit, ingestion answers 503 with `Retry-After` and collectors retry with the same IDs. See [capacity and limits](api.md#capacity-and-limits).

## Deploy with Tako

`tako.compose.toml` runs `compose.yaml` as one Tako Compose group. The services with `x-tako` (`ingest` and `dashboard`) are Tako apps with their own routes; `clickhouse` and `migrate` stay Docker services. Use a CLI/server release with [Tako Compose support](https://tako.sh/docs/docker-compose). The target server requires Docker Engine and Compose 2.24.4 or newer, with Docker socket access for the `tako-server` service account. Tako's Podman installation alone is insufficient. Verify `docker info` and `docker compose version` as that account.

Set the two ClickHouse passwords as secrets; Tako passes them to Compose interpolation:

```sh
tako -c tako.compose.toml secrets set PIKO_CLICKHOUSE_PASSWORD --env production
tako -c tako.compose.toml secrets set PIKO_INGEST_CLICKHOUSE_PASSWORD --env production
```

Add one server to `tako.compose.toml`:

```toml
[envs.production]
servers = ["your-server"]
```

`compose.yaml` ships development routes only. Routes must be literal, so add your production routes beside each service's development route: the ingest paths and the tracker on the ingest app, and the host on the dashboard.

```yaml
services:
  ingest:
    x-tako:
      envs:
        production:
          routes:
            - piko.example.com/api/ingest
            - piko.example.com/api/logs/*
            - piko.example.com/tracker.js
  dashboard:
    x-tako:
      envs:
        production:
          route: piko.example.com
```

With these routes, ingestion never passes through the dashboard, and a dashboard deploy leaves ingestion and the tracker up. Configure the hostname's Access policy and private origin before serving management traffic; see [the access boundary](access.md#compose-ingress).

```sh
tako -c tako.compose.toml deploy --env production
tako -c tako.compose.toml status --json
tako -c tako.compose.toml logs --env production --days 1
```

Tako handles HTTPS routing and replaces the dashboard's standalone `ports` mapping. ClickHouse remains private on the Compose network. This group does not need the native configs, Linux artifacts built on your workstation, or a shared notification secret.

Not verified yet: that Tako sends the host-plus-path ingest routes to the ingest app while the dashboard owns the host, and live channel hints inside the group. Until channels are verified, the group refreshes like standalone Compose, by polling every 30 seconds. If the path routes do not reach the ingest app, leave the ingest app without production routes; the dashboard's forwarding covers ingestion over the Compose network.

For local Tako HTTPS with Docker available, `tako -c tako.compose.toml dev` starts the group at `https://piko.test` and `https://piko-ingest.test`. These are the native development hostnames too, so stop the native apps first with `bun run dev:stop`. The group needs the two passwords as development secrets, and the native configs in the same checkout share that secret store, where a `PIKO_CLICKHOUSE_PASSWORD` or `PIKO_INGEST_CLICKHOUSE_PASSWORD` secret takes precedence over their development values, so run the group from a separate checkout. Stop the group with `tako -c tako.compose.toml dev stop`, and use `tako -c tako.compose.toml dev --restart` after image, source or config changes; the services do not mount source or reload. Native `bun dev` remains the faster loop for source changes.

## Updates and recovery

Update standalone Compose with `docker compose up --build -d`, and the Tako group by deploying the same config again. `migrate` runs first on every update and must succeed before the apps start. Migrations only add tables, columns with defaults, indexes and views; anything the ingest app reads or writes is removed only in a later release, after an ingest app that no longer uses it. The running ingest app therefore keeps working while migrations run, and the previous images keep working against the migrated schema.

Plain Docker Compose replaces a changed container by stopping it first, so an update briefly interrupts that service; collectors' bounded retries cover a short ingest restart. Tako honors each service's `update_config`: the stateless ingest app updates start-first, and the dashboard, which owns the `piko-data` volume, stops before its replacement starts. A dashboard deploy is a short dashboard outage and no ingestion outage when the ingest routes go straight to the ingest app. While old and new ingest containers overlap, a retry that reaches the other one can be stored twice until a merge removes it (see [deduplication](api.md#deduplication)). Unchanged services keep running.

Do not scale either app above one. Tako's service scale overrides survive deployments, so check them even if the YAML still says one.

Application rollback restores earlier images and configuration against the same volumes. It does not undo migrations or restore data. Test upgrades, a failed startup and restoration against disposable data before production use.

## Backups and restore

Back up two things: ClickHouse's `piko` database, which holds events, logs and the key registry, and the dashboard's `state.sqlite`, which holds projects, sources, key hashes, settings, dashboards and views. The rest of ClickHouse's Piko state is rebuilt: `migrate` creates the schema, settings profiles and shared users, and at startup and every minute the dashboard recreates each project's views, reader user and grant from `state.sqlite` and rewrites the key registry. Tako's app-data backups **do not include Docker named volumes**, so use these procedures for the Tako group too, on the deployment server. Take both backups at about the same time, and store them outside the source/build context with restricted access.

### ClickHouse

Open a ClickHouse client as the admin user:

```sh
docker compose exec clickhouse sh -c 'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD"'
```

Back up the `piko` database to S3 or S3-compatible storage, with a new path for every backup:

```sql
BACKUP DATABASE piko
TO S3('https://your-bucket.s3.amazonaws.com/piko/2026-11-16', '<key id>', '<key secret>');
```

Restore into a fresh stack, whose `piko-clickhouse` volume is empty. Let `migrate` create the schema and users first, then restore the two data tables, which are still empty:

```sh
docker compose run --rm migrate
docker compose exec clickhouse sh -c 'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD"'
```

```sql
RESTORE TABLE piko.events, TABLE piko.logs
FROM S3('https://your-bucket.s3.amazonaws.com/piko/2026-11-16', '<key id>', '<key secret>');
```

`RESTORE` refuses tables that already hold rows, so do not restore into a stack that has been ingesting. Restore `state.sqlite` next, then start everything with `docker compose up -d`.

### SQLite

`VACUUM INTO` writes a consistent copy of `state.sqlite` while the dashboard keeps running:

```sh
docker compose exec dashboard bun -e 'new (require("bun:sqlite").Database)("/data/state.sqlite").run("VACUUM INTO ?", ["/tmp/state.sqlite"])'
docker compose cp dashboard:/tmp/state.sqlite ./piko-state.sqlite
docker compose exec dashboard rm /tmp/state.sqlite
```

The copy holds key hashes and display prefixes, never key secrets. To restore, stop the dashboard, replace the database and its WAL files in the `piko-data` volume, and start again:

```sh
docker compose stop dashboard
docker compose run --rm --no-deps -v "$PWD/piko-state.sqlite:/restore.sqlite:ro" dashboard \
  sh -c 'rm -f /data/state.sqlite-wal /data/state.sqlite-shm && cp /restore.sqlite /data/state.sqlite'
docker compose up -d
```

The dashboard rewrites the key registry from the restored file when it starts. Keys created after the snapshot are not in it, but their registry rows stay in ClickHouse, so they keep authorizing ingestion until those rows are removed from `piko.ingest_keys`. Events of a project the snapshot does not hold stay stored but no page shows them.

### Separate storage per deployment

Native Tako, local Tako Compose, the deployed group and standalone Compose have separate storage. Selecting another config does not copy or share data. Tako scopes Compose projects and volumes by app and environment; local development also isolates checkouts and variants. Keep the app name, environment and server stable to keep a deployed volume. Named volumes survive deployment, stop/start, rollback and app deletion; explicitly deleting a Docker volume destroys its data. Do not use application deletion as an update procedure. To move an installation, take both backups, restore them into the new stack as above, and verify projects, keys, queries and duplicate retries before pointing collectors at it.
