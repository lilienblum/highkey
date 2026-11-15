// Ingestion keys (`pk_`) and log keys (`pl_`). Only a SHA-256 hash of each secret is kept.
import { createHash } from "node:crypto";
import { bad, missing } from "../api/errors";
import { normalizeOrigins } from "../origins";
import { product, requireProduct } from "./products";
import { getSource, keySource } from "./sources";
import { newId, now, type Store } from "./sqlite";

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

export function createKey(
  store: Store,
  productId: string,
  label: string,
  sourceId: string | null | undefined,
  allowedOrigins: readonly string[],
) {
  requireProduct(store, productId);
  const source = sourceId ?? productId;
  getSource(store, productId, source);
  checkLabel(label);
  const origins = normalizeOrigins(allowedOrigins);
  const key = newSecret("pk_");
  const id = newId();
  store.db
    .query(
      "INSERT INTO ingestion_keys(id, product_id, label, prefix, hash, created_at, source_id, allowed_origins) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      productId,
      label.trim(),
      key.slice(0, 11),
      hashSecret(key),
      now(),
      source,
      JSON.stringify(origins),
    );
  return { id, key, source_id: source, allowed_origins: origins };
}

export function updateKeyOrigins(
  store: Store,
  productId: string,
  keyId: string,
  allowedOrigins: readonly string[],
): string[] {
  const origins = normalizeOrigins(allowedOrigins);
  const changed = store.db
    .query(
      "UPDATE ingestion_keys SET allowed_origins = ? WHERE product_id = ? AND id = ? AND revoked = 0",
    )
    .run(JSON.stringify(origins), productId, keyId).changes;
  if (changed === 0) throw missing();
  return origins;
}

export function revokeKey(store: Store, productId: string, keyId: string): void {
  const changed = store.db
    .query("UPDATE ingestion_keys SET revoked = 1 WHERE product_id = ? AND id = ?")
    .run(productId, keyId).changes;
  if (changed === 0) throw missing();
}

export function listKeys(store: Store, productId: string): KeyInfo[] {
  requireProduct(store, productId);
  const rows = store.db
    .query(
      "SELECT id, label, prefix, created_at, revoked, source_id, allowed_origins FROM ingestion_keys WHERE product_id = ? ORDER BY created_at, id",
    )
    .all(productId) as (Omit<KeyInfo, "revoked" | "allowed_origins"> & {
    revoked: number;
    allowed_origins: string;
  })[];
  return rows.map((row) => ({
    ...row,
    revoked: row.revoked === 1,
    allowed_origins: JSON.parse(row.allowed_origins) as string[],
  }));
}

// ---- log keys and settings ----

export function logRetention(store: Store, productId: string): number {
  requireProduct(store, productId);
  const row = store.db
    .query("SELECT retention_days FROM log_settings WHERE product_id = ?")
    .get(productId) as { retention_days: number } | null;
  return row?.retention_days ?? 7;
}

export function setLogRetention(store: Store, productId: string, days: number): number {
  requireProduct(store, productId);
  if (!Number.isInteger(days) || days < 1 || days > 365)
    throw bad("Log retention must be 1–365 days");
  store.db
    .query(
      "INSERT INTO log_settings(product_id, retention_days) VALUES (?, ?) ON CONFLICT(product_id) DO UPDATE SET retention_days = excluded.retention_days",
    )
    .run(productId, days);
  return days;
}

export function createLogKey(
  store: Store,
  productId: string,
  label: string,
  sourceId?: string | null,
) {
  const project = product(store, productId);
  const source = keySource(project.sources, productId, sourceId).id;
  checkLabel(label);
  const key = newSecret("pl_");
  const id = newId();
  store.db
    .query(
      "INSERT INTO log_keys(id, product_id, source_id, label, prefix, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, productId, source, label.trim(), key.slice(0, 11), hashSecret(key), now());
  return { id, key, source_id: source };
}

export function listLogKeys(store: Store, productId: string) {
  requireProduct(store, productId);
  const rows = store.db
    .query(
      "SELECT id, source_id, label, prefix, created_at, revoked FROM log_keys WHERE product_id = ? ORDER BY created_at, id",
    )
    .all(productId) as {
    id: string;
    source_id: string;
    label: string;
    prefix: string;
    created_at: string;
    revoked: number;
  }[];
  return rows.map((row) => ({ ...row, revoked: row.revoked === 1 }));
}

export function revokeLogKey(store: Store, productId: string, keyId: string): void {
  requireProduct(store, productId);
  const changed = store.db
    .query("UPDATE log_keys SET revoked = 1 WHERE id = ? AND product_id = ?")
    .run(keyId, productId).changes;
  if (changed === 0) throw missing();
}
