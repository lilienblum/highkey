import { Database } from "bun:sqlite";
import { expect, test } from "@playwright/test";
import { Err } from "../apps/app/src/lib/error-codes";
import { assertIsolatedE2E } from "../scripts/e2e-config";
import { apiHeaders, E2E_DATABASE } from "./auth";

test("a failed workspace load shows its support code and retries after recovery", async ({
  page,
}) => {
  assertIsolatedE2E(process.env);
  const project = await fetch(`${process.env.HIGHKEY_API_URL}/api/products`, {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify({ name: `Recovery ${Date.now()}`, retention_days: 7 }),
  });
  expect(project.ok).toBe(true);
  const { id, slug } = await project.json();
  const db = new Database(E2E_DATABASE, { create: false });
  const setWebsites = db.query("UPDATE products SET website_urls=? WHERE id=?");
  try {
    // Only this disposable project's catalog row fails to deserialize.
    setWebsites.run("invalid JSON", id);
    await page.goto(`/owner/${slug}`);
    await expect(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible();
    await expect(
      page.getByText(`Error code: ${Err.WorkspaceLoadFailed}`, { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "support@usehighkey.com" })).toHaveAttribute(
      "href",
      `mailto:support@usehighkey.com?subject=Highkey%20error%20${Err.WorkspaceLoadFailed}`,
    );
    await expect(page.getByRole("link", { name: "Go home" })).toHaveAttribute("href", "/");
    setWebsites.run("[]", id);
    await page.getByRole("link", { name: "Try again" }).click();
    await expect(page.getByRole("link", { name: "Overview", exact: true })).toBeVisible();
  } finally {
    setWebsites.run("[]", id);
    db.close();
  }
});
