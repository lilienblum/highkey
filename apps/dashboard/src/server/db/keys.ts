// Ingestion keys (`pk_`) and log keys (`pl_`). Only a SHA-256 hash of each secret is kept.
import { createHash } from "node:crypto";
import { bad, missing } from "../api/errors";
import { normalizeOrigins } from "../origins";
import { all, changes, type Db, one } from "./db";
import { product, requireProduct } from "./products";
import { getSource, keySource } from "./sources";
import { newId, now } from "./sqlite";

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function newSecret(prefix: "pk_" | "pl_"): string {
  const simple = () => crypto.randomUUID().replaceAll("-", "");
  return `${prefix}${simple()}${simple()}`;
}

function checkLabel(label: string): void {
  if (!label.trim() || new TextEncoder().encode(label).length > 80)
    throw bad("Key label must be 1–80 bytes");
}

export interface KeyInfo {
  allowed_origins: string[];
  id: string;
  source_id: string;
  label: string;
  prefix: string;
  created_at: string;
  revoked: boolean;
}

export async function createKey(
  db: Db,
  productId: string,
  label: string,
  sourceId: string | null | undefined,
  allowedOrigins: readonly string[],
) {
  await requireProduct(db, productId);
  const source = sourceId ?? productId;
  await getSource(db, productId, source);
  checkLabel(label);
  const origins = normalizeOrigins(allowedOrigins);
  const key = newSecret("pk_");
  const id = newId();
  await db.execute(
    "INSERT INTO ingestion_keys(id, product_id, label, prefix, hash, created_at, source_id, allowed_origins) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      id,
      productId,
      label.trim(),
      key.slice(0, 11),
      hashSecret(key),
      now(),
      source,
      JSON.stringify(origins),
    ],
  );
  return { id, key, source_id: source, allowed_origins: origins };
}

export async function updateKeyOrigins(
  db: Db,
  productId: string,
  keyId: string,
  allowedOrigins: readonly string[],
): Promise<string[]> {
  const origins = normalizeOrigins(allowedOrigins);
  const changed = await changes(
    db,
    "UPDATE ingestion_keys SET allowed_origins = ? WHERE product_id = ? AND id = ? AND revoked = 0",
    [JSON.stringify(origins), productId, keyId],
  );
  if (changed === 0) throw missing();
  return origins;
}

export async function revokeKey(db: Db, productId: string, keyId: string): Promise<void> {
  const changed = await changes(
    db,
    "UPDATE ingestion_keys SET revoked = 1 WHERE product_id = ? AND id = ?",
    [productId, keyId],
  );
  if (changed === 0) throw missing();
}

export async function listKeys(db: Db, productId: string): Promise<KeyInfo[]> {
  await requireProduct(db, productId);
  const rows = await all<
    Omit<KeyInfo, "revoked" | "allowed_origins"> & { revoked: number; allowed_origins: string }
  >(
    db,
    "SELECT id, label, prefix, created_at, revoked, source_id, allowed_origins FROM ingestion_keys WHERE product_id = ? ORDER BY created_at, id",
    [productId],
  );
  return rows.map((row) => ({
    ...row,
    revoked: row.revoked === 1,
    allowed_origins: JSON.parse(row.allowed_origins) as string[],
  }));
}

// ---- log keys and settings ----

export async function logRetention(db: Db, productId: string): Promise<number> {
  await requireProduct(db, productId);
  const row = await one<{ retention_days: number }>(
    db,
    "SELECT retention_days FROM log_settings WHERE product_id = ?",
    [productId],
  );
  return row?.retention_days ?? 7;
}

export async function setLogRetention(db: Db, productId: string, days: number): Promise<number> {
  await requireProduct(db, productId);
  if (!Number.isInteger(days) || days < 1 || days > 365)
    throw bad("Log retention must be 1–365 days");
  await db.execute(
    "INSERT INTO log_settings(product_id, retention_days) VALUES (?, ?) ON CONFLICT(product_id) DO UPDATE SET retention_days = excluded.retention_days",
    [productId, days],
  );
  return days;
}

export async function createLogKey(
  db: Db,
  productId: string,
  label: string,
  sourceId?: string | null,
) {
  const project = await product(db, productId);
  const source = keySource(project.sources, productId, sourceId).id;
  checkLabel(label);
  const key = newSecret("pl_");
  const id = newId();
  await db.execute(
    "INSERT INTO log_keys(id, product_id, source_id, label, prefix, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, productId, source, label.trim(), key.slice(0, 11), hashSecret(key), now()],
  );
  return { id, key, source_id: source };
}

export async function listLogKeys(db: Db, productId: string) {
  await requireProduct(db, productId);
  const rows = await all<{
    id: string;
    source_id: string;
    label: string;
    prefix: string;
    created_at: string;
    revoked: number;
  }>(
    db,
    "SELECT id, source_id, label, prefix, created_at, revoked FROM log_keys WHERE product_id = ? ORDER BY created_at, id",
    [productId],
  );
  return rows.map((row) => ({ ...row, revoked: row.revoked === 1 }));
}

export async function revokeLogKey(db: Db, productId: string, keyId: string): Promise<void> {
  await requireProduct(db, productId);
  const changed = await changes(
    db,
    "UPDATE log_keys SET revoked = 1 WHERE id = ? AND product_id = ?",
    [keyId, productId],
  );
  if (changed === 0) throw missing();
}
