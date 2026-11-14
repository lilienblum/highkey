# Docker Compose

Piko supports Compose alongside [native Tako](tako.md). Both use the same Rust API and Bun dashboard. Compose runs the standalone servers: Overview and Events refresh every 30 seconds while visible and online, and on focus/reconnect. Immediate Tako channel hints are available with the native option. No notification secret is needed for Compose.

The shared `compose.yaml` builds two targets from the root Dockerfile. Only the dashboard is exposed; it forwards `/api/*` to `http://api:3001`. The API owns the `piko-data` named volume mounted at `/data`. Keep one API replica. Both services have health checks, and dashboard startup waits for a healthy API.

## Run with Docker Compose

Install Docker Engine with the Compose plugin, or Docker Desktop/OrbStack locally. From the repository root:

```sh
docker compose up --build -d
docker compose ps
```

Open http://127.0.0.1:3000. The API port is private. Builds run inside Linux containers; local Bun, Rust, and C++ toolchains are unnecessary for this option. The first API build compiles DuckDB and can take several minutes.

Use `docker compose logs --tail 100` to inspect startup. After source changes, rerun `docker compose up --build -d`. Stop with `docker compose down`, which retains the named volume. Do not add `--volumes` when retaining data. The Compose project name determines which volume is used; keep it stable for an existing installation.

Protect the dashboard with Cloudflare Tunnel and Access before exposing it. Only `/api/ingest` and `/tracker.js` receive public Access bypasses; see [the access boundary](access.md#compose-ingress).

## CORS for read-only pages

The API allows cross-origin requests to `/api/read/*` from loopback origins by default. To let a page served elsewhere read it, set `PIKO_CORS_ORIGINS` on the API service: a comma-separated list of exact origins (scheme, host and port; no trailing slash and no path). `null` is never allowed, and `*` is accepted by the code but should not be used. Add it to the `api` service's `environment` in `compose.yaml`:

```yaml
services:
  api:
    environment:
      PIKO_CORS_ORIGINS: "https://wall.example.com,http://192.168.1.20:8080"
```

Recreate the API with `docker compose up -d`. The API restart is brief but interrupts queries and ingestion; see [updates](#updates-and-recovery). See [local pages](dashboards.md#local-pages) and [access](access.md#local-pages-and-cors) for what the allowlist covers and the Access settings it needs. Native Tako sets it under `[vars.production]` in `tako.api.toml`.

## Memory ceiling

The API sets no memory ceiling by default. A runaway query then grows until the kernel stops the API (and ingestion with it) or the container hits its own limit. On Linux you can opt in to a ceiling, so such a query fails with an Out of Memory error instead. Set `PIKO_MEMORY_LIMIT` on the API service to `auto`, which is 80% of the smaller of the container's memory limit and the host's memory, or to a size in bytes with an optional `K`, `M` or `G` suffix. Unset, empty, `0` and `off` mean no ceiling. `docker compose logs api` shows what the API chose.

```yaml
services:
  api:
    environment:
      PIKO_MEMORY_LIMIT: "auto" # or a size such as "2G"
    mem_limit: 2g
```

The ceiling counts reserved memory as well as resident memory, and every open project database reserves thread stacks, so it must leave room for all of your projects' databases. Use `auto` only with a container memory limit of a few GiB or more, and see the [resource model](api.md#resource-model) for sizing. Recreate the API with `docker compose up -d`.

## Deploy with Tako

Use a CLI/server release with [Tako Compose support](https://tako.sh/docs/docker-compose). The target server requires Docker Engine and Compose 2.24.4 or newer, with Docker socket access for the `tako-server` service account. Tako's Podman installation alone is insufficient. Verify `docker info` and `docker compose version` as that account.

`tako.compose.toml` selects the dashboard on port 3000 and its `/health` endpoint. Its separate `piko-compose` identity avoids replacing either native app. Add your production route and one server to that file:

```toml
[envs.production]
route = "piko.example.com"
servers = ["your-server"]
```

Use your enrolled Tako server/network configuration as required by your installation. Configure the hostname's external Access policy and private origin before serving management traffic. Choose a different hostname if the native deployment is staying active.

```sh
tako -c tako.compose.toml deploy --env production
tako -c tako.compose.toml status --json
tako -c tako.compose.toml logs --env production --days 1
```

Tako publishes only the selected dashboard service through an assigned loopback port and handles HTTPS routing. It replaces the standalone `ports` mapping. The API remains private on the Compose network. This stack does not need the native configs, Linux artifacts built on your workstation, or a shared notification secret.

For local Tako HTTPS with Docker available:

```sh
tako -c tako.compose.toml dev
# Open https://piko-compose.test
# Stop this stack from another terminal:
tako -c tako.compose.toml dev stop
```

Use `tako -c tako.compose.toml dev --restart` after image/source/config changes; the checked-in services do not mount source or enable hot reload. Native `bun dev` remains available for faster source iteration.

## Updates and recovery

Redeploy the same config after changes. Tako keeps unchanged services running. `api.deploy.replicas = 1` and `update_config.order = stop-first` stop the old API before starting its replacement; never override these with multiple API replicas or start-first updates. API replacement briefly interrupts queries and ingestion. Collectors must retain their normal bounded retry behavior. The stateless dashboard uses start-first replacement.

Tako supports Compose on one server. Service scale overrides survive deployments, so do not scale `api` above one even if the YAML still says one. The OS directory lock is a final guard against concurrent database owners, not a way to run overlapping API releases.

Application rollback restores earlier images and configuration against the same volume. It does not undo database migrations or restore analytics data. A downgrade requiring an earlier schema needs a matching stopped-data backup. Test upgrades, a failed startup, and restoration against disposable data before production use.

## Backups and migration

Native Tako, local Tako Compose, deployed Tako Compose, and standalone Compose have separate storage. Selecting another config does not copy or share existing data. Tako scopes Compose projects and volumes by app/environment; local development additionally isolates checkouts and variants. Keep the app name, environment, and server stable when retaining a deployed volume.

Tako's app-data backups **do not include Docker named volumes**. Back up the API's entire `/data` directory while its API container is stopped, including `state.sqlite`, any SQLite WAL files, all `products/` and `logs/` databases and WAL files, and cached metadata. Restore the whole directory into an empty destination with the API stopped. The image runs as UID 10001; restored files must remain writable by that user. Never copy active database files or share a data directory between deployments.

For a standalone backup, stop the API, copy its directory, and restart it:

```sh
docker compose stop api
docker compose cp api:/data ../piko-data-backup
docker compose start api
```

Choose a fresh backup destination each time. Store backups outside the source/build context with appropriate access restrictions. Coordinate the equivalent stopped-volume copy on the deployment server for Tako-managed Compose. Named volumes survive Tako deployment, stop/start, rollback, and app deletion; explicitly deleting the Docker volume destroys the data. Do not use application deletion as an update procedure.

To move an existing installation, stop and gate the source API using its deployment's maintenance procedure, preserve a full backup, then copy it into an empty stopped destination volume. Verify project/source counts, queries, existing ingestion keys, and duplicate retries before directing collectors to the destination. Keep the original stopped data until verification succeeds. Restore a backup into a separate disposable stack to verify recovery.
