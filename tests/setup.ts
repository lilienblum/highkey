import { request } from "@playwright/test";
import { E2E_OWNER, E2E_STATE } from "./auth";

// Every browser test runs as the owner of the workspace (the first account, so also the server
// admin) and calls the API with that owner's write key. The dashboard must start empty.
export default async function setup() {
  const base = process.env.HIGHKEY_API_URL as string;
  const api = await request.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
  const signedUp = await api.post("/api/auth/sign-up/email", {
    data: { name: "Owner", email: E2E_OWNER.email, password: E2E_OWNER.password },
    timeout: 15_000,
  });
  if (!signedUp.ok())
    throw new Error(
      `Refusing to run browser tests: the dashboard must have a fresh, empty database (sign-up answered ${signedUp.status()}).`,
    );
  const projects = await api.get("/api/products");
  if (!projects.ok()) throw new Error(`E2E dashboard API preflight failed (${projects.status()})`);
  const listed = await projects.json();
  if (!Array.isArray(listed) || listed.length !== 0)
    throw new Error(
      "Refusing to run browser tests: the dashboard must have a fresh, empty database.",
    );
  const key = await api.post("/api/keys", { data: { name: "Browser tests", access: "write" } });
  if (!key.ok()) throw new Error(`Could not create the browser tests' API key (${key.status()})`);
  process.env.HIGHKEY_E2E_KEY = ((await key.json()) as { key: string }).key;
  const session = await api.get("/api/auth/get-session");
  process.env.HIGHKEY_E2E_ORG = (
    (await session.json()) as { session: { activeOrganizationId: string } }
  ).session.activeOrganizationId;
  await api.storageState({ path: E2E_STATE });
  await api.dispose();
}
