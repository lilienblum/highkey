import { expect, test } from "bun:test";
import { ensureProjectAccess, Readers } from "../src/server/clickhouse/access";
import { testAdmin } from "./helpers";
import { testClickHouse } from "./clickhouse";

test("AI prompts disappear from readers at 30 days and TTL clears the stored text without losing metrics", async () => {
  const admin = await testAdmin();
  const server = await testClickHouse();
  const id = crypto.randomUUID();
  const secret = "ai-retention-test";
  await ensureProjectAccess(admin, id, secret);
  await admin.command(
    `INSERT INTO highkey.events (product_id, source_id, event_id, name, source, event_time, received_at, properties, ai_prompt, expires_at)
     VALUES ({p:UUID}, {p:UUID}, 'old-prompt', 'ai_generation', 'server', now() - INTERVAL 31 DAY, now(), '{"cost":0.01}', 'private prompt', now() + INTERVAL 30 DAY)`,
    { params: { p: id } },
  );
  const reader = new Readers({ url: server.url, secret }).reader(id);
  const read = await reader.query<{ ai_prompt: string; properties: { cost: number } }>(
    "SELECT ai_prompt, properties FROM all_events",
  );
  expect(read.data[0]).toEqual({ ai_prompt: "", properties: { cost: 0.01 } });
  await admin.command("ALTER TABLE highkey.events MATERIALIZE TTL", {
    settings: { mutations_sync: 2 },
  });
  const stored = await admin.query<{ ai_prompt: string }>(
    "SELECT ai_prompt FROM highkey.events WHERE product_id = {p:UUID}",
    { params: { p: id } },
  );
  expect(stored.data).toEqual([{ ai_prompt: "" }]);
}, 300_000);
