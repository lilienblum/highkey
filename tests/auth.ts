// The account the browser tests run as, and how they call the API.
import { join } from "node:path";

export const E2E_OWNER = { email: "owner@highkey-e2e.test", password: "browser tests password" };

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
