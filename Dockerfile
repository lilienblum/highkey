# syntax=docker/dockerfile:1
# The Rust stage copies only what the ingest app is built from, so a dashboard or tracker change
# leaves its layers (and the ingest image) unchanged.
FROM rust:1-bookworm AS ingest-build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY apps/ingest ./apps/ingest
COPY sdk/rust ./sdk/rust
RUN cargo build --locked --release -p piko-ingest

# The browser tracker: the dependency-free SDK bundled into one module the ingest app serves.
FROM oven/bun:1.4.4 AS tracker-build
WORKDIR /sdk
COPY sdk/typescript ./
RUN bun run build:tracker

FROM debian:bookworm-slim AS ingest
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/* && useradd -u 10001 -m piko
COPY --from=ingest-build /app/target/release/piko-ingest /usr/local/bin/piko-ingest
COPY --from=tracker-build /sdk/dist/tracker.js /srv/tracker.js
USER piko
ENV PIKO_BIND=0.0.0.0:3001 PIKO_TRACKER_PATH=/srv/tracker.js
EXPOSE 3001
CMD ["piko-ingest"]

FROM oven/bun:1.4.4 AS dashboard-build
WORKDIR /app
COPY package.json bun.lock tsconfig.json bunfig.toml ./
COPY apps/dashboard/package.json ./apps/dashboard/package.json
COPY sdk/typescript/package.json ./sdk/typescript/package.json
RUN bun install --frozen-lockfile
COPY apps/dashboard ./apps/dashboard
COPY sdk ./sdk
RUN cd apps/dashboard && bun run build

FROM oven/bun:1.4.4-slim AS dashboard
WORKDIR /app
COPY --from=dashboard-build --chown=bun:bun /app/node_modules ./node_modules
COPY --from=dashboard-build --chown=bun:bun /app/apps/dashboard ./apps/dashboard
# `bun run migrate` (the Compose migrate job) applies these.
COPY --chown=bun:bun clickhouse/migrations ./clickhouse/migrations
RUN mkdir /data && chown bun:bun /data
USER bun
ENV HOST=0.0.0.0 PORT=3000 PIKO_DATA_DIR=/data
VOLUME /data
EXPOSE 3000
WORKDIR /app/apps/dashboard
CMD ["bun", "server.ts"]
