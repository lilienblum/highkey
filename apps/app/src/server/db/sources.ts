// A project's sources. Every project starts with one whose id is the project's own.
import { ApiError, bad, missing, sourceMissing } from "../api/errors";
import { changes, type Db, one, all } from "./db";
import { requireProduct } from "./products";
import { newId, now } from "./ids";

export interface Source {
  visitor_mode: "off" | "persistent" | "cookieless";
  icon: string | null;
  id: string;
  product_id: string;
  name: string;
  slug: string;
  created_at: string;
}

export const SOURCE_ICONS = [
  "website",
  "ios",
  "android",
  "mobile",
  "terminal",
  "desktop",
  "server",
  "code",
  "package",
  "game",
  "generic",
] as const;

/** Workspace URLs use `?source=all` for the combined view, so no source may take this slug. */
const ALL_SOURCES = "all";

export function projectSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .split(/[^a-z0-9]/)
    .filter(Boolean)
    .join("-")
    .slice(0, 64)
    .replace(/-+$/, "");
  return slug || "project";
}

function sourceSlug(name: string): string {
  return /[a-z0-9]/i.test(name) ? projectSlug(name) : "source";
}

function suffixed(base: string, suffix: number): string {
  const tail = `-${suffix}`;
  return `${base.slice(0, 64 - tail.length).replace(/-+$/, "")}${tail}`;
}

const COLUMNS = "id, product_id, name, icon, created_at, slug, visitor_mode";

export function listSources(db: Db, productId: string): Promise<Source[]> {
  return all<Source>(
    db,
    `SELECT ${COLUMNS} FROM sources WHERE product_id = ? ORDER BY created_at, id`,
    [productId],
  );
}

export async function getSource(db: Db, productId: string, id: string): Promise<Source> {
  const source = await one<Source>(
    db,
    `SELECT ${COLUMNS} FROM sources WHERE product_id = ? AND id = ?`,
    [productId, id],
  );
  if (!source) throw missing();
  return source;
}

/** A source the project has, for a read query filtered by one. */
export async function requireSource(db: Db, productId: string, id: string): Promise<void> {
  try {
    await getSource(db, productId, id);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) throw sourceMissing();
    throw error;
  }
}

/** A source of the project by id, or else by slug. */
export async function resolveSource(db: Db, productId: string, key: string): Promise<Source> {
  const source = await one<Source>(
    db,
    `SELECT ${COLUMNS} FROM sources WHERE product_id = ?1 AND (id = ?2 OR slug = ?2) ORDER BY id = ?2 DESC`,
    [productId, key],
  );
  if (!source) throw missing();
  return source;
}

/** The source a new key binds to: the one named, else the project's initial source. */
export function keySource(sources: Source[], productId: string, id?: string | null): Source {
  if (id) {
    const source = sources.find((s) => s.id === id);
    if (!source) throw missing();
    return source;
  }
  const source = sources.find((s) => s.id === productId) ?? sources[0];
  if (!source) throw bad("Create a source before creating a key");
  return source;
}

export interface SourceInput {
  visitor_mode?: string | null;
  name: string;
  icon?: string | null;
}

export function validateSource(input: SourceInput): void {
  if (
    input.visitor_mode != null &&
    !["off", "cookieless", "persistent"].includes(input.visitor_mode)
  )
    throw bad("Visitor counting must be off, cookieless or persistent");
  if (input.icon != null && !(SOURCE_ICONS as readonly string[]).includes(input.icon))
    throw bad(
      "Unknown source icon; use website/ios/android/mobile/terminal/desktop/server/code/package/game/generic, or null for automatic",
    );
  const bytes = new TextEncoder().encode(input.name.trim()).length;
  if (bytes === 0 || new TextEncoder().encode(input.name).length > 80)
    throw bad("Use a source name of 1–80 bytes");
}

function duplicateName(error: unknown): never {
  if (
    error instanceof Error &&
    /UNIQUE constraint failed: sources\.product_id, sources\.name/.test(error.message)
  )
    throw bad("A source with that name already exists in this project");
  throw error;
}

export async function saveSource(
  db: Db,
  productId: string,
  id: string | null,
  input: SourceInput,
): Promise<Source> {
  validateSource(input);
  await requireProduct(db, productId);
  const name = input.name.trim();
  if (id) {
    await getSource(db, productId, id);
    // Renames keep the slug, so workspace links stay valid.
    try {
      await db.execute(
        "UPDATE sources SET name = ?3, icon = CASE WHEN ?4 THEN ?5 ELSE icon END, visitor_mode=coalesce(?6,visitor_mode) WHERE product_id = ?1 AND id = ?2",
        [
          productId,
          id,
          name,
          Number(input.icon !== undefined),
          input.icon ?? null,
          input.visitor_mode ?? null,
        ],
      );
    } catch (error) {
      duplicateName(error);
    }
    return getSource(db, productId, id);
  }
  const sourceId = newId();
  const base = sourceSlug(name);
  let slug = base;
  for (let suffix = 2; ; suffix++) {
    if (slug !== ALL_SOURCES) {
      let inserted: number;
      try {
        inserted = await changes(
          db,
          "INSERT INTO sources(id, product_id, name, icon, created_at, slug,visitor_mode) VALUES (?, ?, ?, ?, ?, ?,?) ON CONFLICT(product_id, slug) DO NOTHING",
          [sourceId, productId, name, input.icon ?? null, now(), slug, input.visitor_mode ?? "off"],
        );
      } catch (error) {
        duplicateName(error);
      }
      if (inserted === 1) break;
    }
    slug = suffixed(base, suffix);
  }
  return getSource(db, productId, sourceId);
}
