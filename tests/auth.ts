// The account the browser tests run as, and how they call the API.
import { join } from "node:path";
import { E2E_ENV } from "../scripts/e2e-config";

export const E2E_OWNER = { email: "owner@highkey-e2e.test", password: "browser tests password" };

/** The main config's isolated Tako database, including its real migrations. */
export const E2E_DATABASE = join(
  process.cwd(),
  ".tako",
  "data",
  "envs",
  E2E_ENV,
  "databases",
  "highkey-test-e2e.sqlite",
);

/** The owner's signed-in browser state, written by setup.ts. */
export const E2E_STATE = join(
  process.cwd(),
  ".tako",
  "e2e",
  `${process.env.HIGHKEY_E2E_RUN ?? "local"}-owner.json`,
);

/** Headers for API calls as the owner: their write API key. */
export function apiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${process.env.HIGHKEY_E2E_KEY}`,
    "content-type": "application/json",
    ...extra,
  };
}
