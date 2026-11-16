# Cloudflare Access is the authentication boundary

Piko intentionally has **no built-in authentication**. Neither app validates Access tokens or trusts an identity header as an authorization check. Access is enforced before traffic reaches the origin. Keep the origins private: use Cloudflare Tunnel, or an equivalent private network boundary. In Compose, ClickHouse and the ingest app have no published ports, and the dashboard is bound to localhost by default. Do not expose any of them directly to the Internet; ClickHouse in particular is never public.

For a deployment at `piko.example.com`:

| Access application path             | Policy                                      | Purpose                                                   |
| ----------------------------------- | ------------------------------------------- | --------------------------------------------------------- |
| `piko.example.com`                  | Allow only your chosen users/groups         | Dashboard and all management endpoints                    |
| `piko.example.com/api/ingest`       | Bypass / Everyone                           | Public write-only collectors and their OPTIONS preflights |
| `piko.example.com/api/logs/ingest`  | Bypass / Everyone (if collecting logs)      | Service logs authorized by separate `pl_` log keys        |
| `piko.example.com/api/logs/v1/logs` | Bypass / Everyone (if collecting OTLP logs) | OTLP/HTTP exporters authorized by log keys                |
| `piko.example.com/tracker.js`       | Bypass / Everyone                           | Public standalone browser module                          |

The bypassed paths are exactly the ones the ingest app serves. Create separate path-specific self-hosted Access applications for them. Cloudflare applies more-specific application paths ahead of broader paths; those policies are not inherited from the parent. This is documented in [application path precedence](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/) and [bypassing public endpoints](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/).

Do **not** bypass `/api/*`: project creation, key management, cleanup, and analytical queries must remain covered by Access. The tracker is a standalone bundle; its public import needs only `/tracker.js`, not the dashboard's `/assets/*`. Allow preflight OPTIONS on the ingest paths; preflight requests carry no Access credentials. The ingest app accepts only POST and its CORS preflight on these paths, with source-scoped ingestion-key authorization.

Point your Tunnel's hostname at the Bun dashboard (`http://localhost:3000`, or `http://dashboard:3000` from the same container network). Optionally add path rules that send the ingest paths and `/tracker.js` to the ingest app; otherwise the dashboard forwards them. The Access policies are the same either way, because Access applies at the edge before the Tunnel routes a request. Apply your Access allow policy to the hostname before publishing it. No Cloudflare account or Tunnel is configured automatically by this repository.

Verify from a signed-out browser or unauthenticated client after configuring the edge:

- `/`, `/events`, `/settings`, and `/api/products` require Access authentication.
- `/api/products/<id>/query`, project/key mutation paths, and `/api/cleanup` cannot bypass Access.
- `/tracker.js` loads as a public JavaScript module with CORS.
- `OPTIONS /api/ingest` succeeds; `POST /api/ingest` without an ingestion key returns 401; a valid ingestion key can only send to its own project.
- The origin addresses and ports, including ClickHouse's, are unreachable directly from the Internet.

Access configuration is deployment-specific and was not provisioned or verified against a live Cloudflare account during local development. The local tests verify key scoping, the CSRF marker, CORS, and browser tracking; they do not assert that an external Access policy is installed.

## MCP and read-only access

Agents and local pages reach Piko through two dashboard prefixes that you can give separate Access policies. Both authenticate with a Cloudflare Access [service token](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/) (a `CF-Access-Client-Id` and `CF-Access-Client-Secret` pair). Piko itself never sees a login: it has no built-in token, and nothing here adds one.

| Access application path     | Policy                                                                                                                  | Purpose                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `piko.example.com/api/read` | Two policies: Allow your users and groups (the same as the main application), plus Service Auth for the read-only token | The dashboard UI itself calls these paths as the signed-in user; the token serves read-only agents and pages |
| `piko.example.com`          | Allow your users, plus Service Auth for the full token                                                                  | Everything else, including `/mcp`, which can change dashboards, views, projects, sources and keys            |

- **Read-only token.** Add a more specific Access application for `piko.example.com/api/read/*` with two policies: an Allow policy for the same users and groups as the main application, and a Service Auth policy for one token. The dashboard UI loads dashboards, widget runs, the catalog and saved views from `/api/read/*` as the signed-in user, and a more specific application replaces the main policy for its paths, so an application that allows only the token locks every signed-in person out of dashboards and views. Everything under `/api/read` is non-mutating whatever its method, so the token cannot write or create keys. It can still read your analytics and raw event and log samples; see [privacy](privacy.md#ai-agents-and-mcp).
- **Full token.** A service token allowed on the main application can use `/mcp` and every management endpoint. Treat it as full trust: it is as powerful as a signed-in admin, it can create and revoke keys and see their secrets, and anyone who holds it holds all of that. Keep it in the agent's own configuration, give each agent its own token so you can revoke one, and set a short Access token duration if you can.
- **Agent setup.** Point the client at `https://piko.example.com/mcp` (or `/api/read/mcp` with the read token) and send the two headers. [Claude Code and Codex configuration](dashboards.md#ask-your-ai) is in the dashboards guide. Local development has no Access and needs no headers.
- The dashboard refuses MCP requests that carry a browser `Origin` header, so a web page cannot use the MCP endpoints even with a leaked token.

### Local pages and CORS

A page you serve on your own machine (see [local pages](dashboards.md#local-pages)) can call `/api/read/*` cross-origin. The dashboard answers loopback origins (`localhost`, `127.0.0.1`, `[::1]`, any port) by default, and other origins listed in `PIKO_CORS_ORIGINS`: comma-separated exact origins with scheme, host and port, no trailing slash and no path, never `null`. A literal `*` is accepted by the code but should not be used. [Compose](compose.md#cors-for-read-only-pages) shows where to set it. Only the headers `Content-Type`, `CF-Access-Client-Id` and `CF-Access-Client-Secret` are allowed, credentials are never enabled, and write paths send no CORS headers.

Access answers a browser's preflight itself, without credentials, with a 403. In the `/api/read/*` application's **Advanced settings → Cross-Origin Resource Sharing**, turn on **Bypass options requests to origin** so the preflight reaches Piko, which then applies its own allowlist. The page sends the read-only token's two headers on the real request. Anything in a page's source is readable by the page's visitors, so keep tokens out of pages you share.

Verify from outside after configuring the edge:

- `GET /api/read/products` without the token redirects or denies at Access; with the read-only token it returns the projects.
- A signed-in user can still open a dashboard in the UI, run its widgets and open saved views.
- `PUT /api/products/<id>/dashboards/<slug>` and `POST /mcp` with the read-only token are denied at Access.
- `POST /api/read/mcp` with the read-only token lists only the read tools.

## Native Tako hosts and realtime

With the native Tako configs, route `piko.example.com` to the dashboard and `piko-ingest.example.com` to the ingest app. Keep both origins private behind the Tunnel. Keep the dashboard's `/_tako/channels/*` receive endpoint under the same Access user policy as the dashboard: it carries workspace-wide project identifiers, and channel parameters are not an authorization boundary.

The ingest host serves only `/api/ingest`, `/api/logs/ingest`, `/api/logs/v1/logs`, `/tracker.js` and `/health`. Bypass Access for the three ingest paths and `/tracker.js` on that host, as in the table above, and leave the rest of the host under a policy that denies the public. It needs no service-auth gateway: the dashboard no longer proxies management to it, and it forwards only ingestion requests, which those bypasses already admit. Both hosts can then take public collection; the dashboard host forwards its ingest paths to `PIKO_INGEST_URL`.

The ingest app needs server-to-server access to **only** `POST piko.example.com/_piko/changes`. A narrow path-specific Access bypass can expose this endpoint because the dashboard itself checks the separate `PIKO_CHANGE_TOKEN` bearer secret before publishing. Missing/wrong credentials fail; the token is never embedded in browser code. Never bypass `/_piko/*` or `/_tako/*` broadly. The public ingestion key does not authorize notifications, queries, or management.

Verify that `/_piko/changes` without its secret returns 401, that `/_tako/channels/*` redirects or denies a signed-out user at Access, and that the ingest host answers only its public paths without Access.

## Compose ingress

Both [Compose options](compose.md) use one public hostname. ClickHouse and the ingest app have no published ports; the dashboard reaches the ingest app at `http://ingest:3001` and ClickHouse at `http://clickhouse:8123`. Use the same dashboard, ingestion, and tracker Access policies listed above. With standalone Compose, the Tunnel can route everything to the dashboard, or add [path rules](compose.md#cloudflare-tunnel) for the ingest paths and `/tracker.js` that reach the ingest container on the Compose network. For the Tako Compose group, direct the private Tunnel at Tako's configured routes rather than assuming the standalone loopback port remains published; Tako assigns its own private ingress ports, and the group's production routes send the ingest paths to the ingest app.

Compose uses automatic polling without Tako channels or change webhooks. It needs no ingest hostname, Access service credential, notification secret, or `/_piko/changes` bypass. Keep `/_piko/*` under the dashboard's normal Access policy.
