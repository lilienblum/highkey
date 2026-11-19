// `bun run migrate`: applies Highkey's ClickHouse migrations. Run it from the release you deploy,
// before the ingest app and the dashboard start.
import { adminClient } from "./client";
import { migrate } from "./migrate";

try {
  const { applied } = await migrate(adminClient(), {
    ingestPassword: process.env.HIGHKEY_INGEST_CLICKHOUSE_PASSWORD ?? "",
  });
  console.log(applied.length ? `Applied ${applied.join(", ")}` : "ClickHouse schema is current");
} catch (error) {
  console.error(
    `ClickHouse migration failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
