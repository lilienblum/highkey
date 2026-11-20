import { type Db, one } from "./db";
import { requireProduct } from "./products";

export async function revenueSettings(db: Db, project: string) {
  await requireProduct(db, project);
  const row = await one<{ allow_browser_revenue: number }>(
    db,
    "SELECT allow_browser_revenue FROM revenue_settings WHERE product_id = ?",
    [project],
  );
  return { allow_browser_revenue: row?.allow_browser_revenue === 1 };
}

export async function setRevenueSettings(db: Db, project: string, allow: boolean) {
  await requireProduct(db, project);
  await db.execute(
    "INSERT INTO revenue_settings(product_id, allow_browser_revenue) VALUES (?, ?) ON CONFLICT(product_id) DO UPDATE SET allow_browser_revenue = excluded.allow_browser_revenue",
    [project, allow ? 1 : 0],
  );
  return { allow_browser_revenue: allow };
}
