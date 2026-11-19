export default async function setup() {
  const response = await fetch(`${process.env.HIGHKEY_API_URL}/api/products`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`E2E dashboard API preflight failed (${response.status})`);
  const projects = await response.json();
  if (!Array.isArray(projects) || projects.length !== 0)
    throw new Error(
      "Refusing to run browser tests: the dashboard must have a fresh, empty database.",
    );
}
