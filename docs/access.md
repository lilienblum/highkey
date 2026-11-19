# Accounts, organizations and access

Highkey has its own sign-in. People have accounts, accounts belong to organizations, and organizations hold projects. Everything except collection (the ingest app's public endpoints) needs a signed-in person, an API key or an agent's OAuth token, and every request acts inside one organization with the role its person holds there now.

Authentication runs on [Better Auth](https://www.better-auth.com/) inside the dashboard, with its tables in the same management database as projects and keys. Set `HIGHKEY_PUBLIC_URL` to the address people use (for example `https://highkey.example.com`) and `BETTER_AUTH_SECRET` to a long random secret (a Tako secret in production). The public URL is the only origin cookie-authenticated writes are accepted from, and a request for any other host (except loopback in development) is refused.

## Accounts

- **Signing up.** `HIGHKEY_SIGNUP=invite` (the default) admits the very first account and people with a pending invitation. `HIGHKEY_SIGNUP=open` admits anyone (the hosted service). Signing up on your own creates an organization named after you, which you own; signing up from an invitation joins only the inviting organization.
- **The server admin.** The first account on a server is its admin, above every organization: they find people and organizations, ban and unban, sign someone out everywhere, hand over a one-time password-reset link, and delete accounts (`/api/admin/*`, server admin only). On an upgraded install, projects that existed before accounts join the first account's organization.
- **Email.** With `HIGHKEY_RESEND_API_KEY` and `HIGHKEY_EMAIL_FROM` set (Tako secrets or environment), Highkey sends plain-text email through [Resend](https://resend.com/): address verification (required before sign-in), password reset links and invitations. Without them there is no email: verification is off, every invitation shows a link to share yourself, and a forgotten password is reset with a link the server admin creates.
- **Two-factor codes.** Anyone can turn on TOTP codes from an authenticator app, with backup codes. An owner who uses them can require them of everyone in the organization; members without codes are then refused (by session, API key or agent) until they turn them on; in the browser they land on their Account settings, where they do. Codes are asked at password sign-in; GitHub and Google sign-in do not ask for them.
- **GitHub and Google.** Each is offered when both its client id and secret are set: `HIGHKEY_GITHUB_CLIENT_ID` and `HIGHKEY_GITHUB_CLIENT_SECRET`, `HIGHKEY_GOOGLE_CLIENT_ID` and `HIGHKEY_GOOGLE_CLIENT_SECRET`. Register the callback `https://highkey.example.com/api/auth/callback/github` (or `/google`).
- **Deleting an account.** People delete their own account (with their password), and the server admin can delete anyone else's. Either is refused while the person is the only owner of an organization with other members; transfer ownership first. Organizations where they are the only member go with them.

## Organizations and roles

A role covers every project of its organization.

| Can                                                    | Owner | Admin | Member | Viewer |
| ------------------------------------------------------ | ----- | ----- | ------ | ------ |
| Read everything: projects, dashboards, events, logs    | yes   | yes   | yes    | yes    |
| Dashboards and views: save, restore, delete            | yes   | yes   | yes    | —      |
| Sources and ingestion keys of every project            | yes   | yes   | yes    | —      |
| Projects: create, update, delete, restore, move        | yes   | yes   | —      | —      |
| People: invite, change roles, remove                   | yes   | yes   | —      | —      |
| Organization: rename; require two-factor codes (owner) | yes   | yes   | —      | —      |
| Organization: delete, transfer ownership               | yes   | —     | —      | —      |
| API keys and agent connections of their own            | yes   | yes   | yes    | read   |
| See and revoke everyone's keys and connections         | yes   | yes   | —      | —      |

- **Invitations** name an email address and a role, and expire after 7 days. The Join page they link to shows who invited you, to which organization and as what. An organization always keeps at least one owner.
- **Moving a project** to another organization needs admin or owner in both (project settings, **Move to another organization**). Its keys, dashboards and views go with it; its data in ClickHouse does not move, because it is stored by project.
- **Deleting a project** (project settings, **Delete project**) stops its ingestion keys at once and hides it everywhere; an admin can restore it for 7 days from **Settings → Organization → Deleted projects**. After that a background job deletes its events and logs, its ClickHouse reader and views, and its records, one project at a time.
- **Deleting an organization** (owner only) is refused while it has projects, deleted ones included until they are wiped. Its members, invitations, API keys and agent connections go with it.
- A removed member, or one demoted to viewer, loses access on their next request: roles are read on every request, not cached in the session.

## API keys

API keys (`hk_…`) let scripts, local pages, scheduled reports and CI reach the API and MCP. Each is created in **Settings → API keys** (or `POST /api/keys`) by a signed-in person for one organization, read-only or read and write, optionally expiring. Send it as `Authorization: Bearer hk_…` or `X-Api-Key: hk_…`.

- A key belongs to the person who made it. On every use it is capped by that person's current role: a removed member's keys stop at once, and a viewer's keys only read (viewers can create read-only keys only).
- Keys are stored hashed and shown once. Owners and admins see everyone's keys in their organization (name, owner, access, last use) and can revoke them; nobody sees a secret again.
- Each key may make 1,000 requests a minute; past that it gets `429` until the minute passes.
- A key cannot create or revoke keys, and never acts as the server admin.
- Collection does not use these keys: ingestion keys (`pk_…`, `pl_…`) are separate, public, and can only send data to their own source.

### Local pages and CORS

A page you serve on your own machine (see [local pages](dashboards.md#local-pages)) can call `/api/read/*` cross-origin with a read-only key. The dashboard answers loopback origins (`localhost`, `127.0.0.1`, `[::1]`, any port) and the exact origins in `HIGHKEY_CORS_ORIGINS` (comma-separated, scheme, host and port, no path, never `null`). It allows the `Content-Type`, `Authorization` and `X-Api-Key` headers, never credentials (cookies), and write paths send no CORS headers. Anything in a page's source is readable by the page's visitors, so keep keys out of pages you share.

## Agents (MCP)

Agents connect to `https://highkey.example.com/mcp`, an OAuth 2.1 protected resource.

1. The agent finds the authorization server through `/.well-known/oauth-protected-resource/mcp` and identifies itself with a [Client ID Metadata Document](https://modelcontextprotocol.io/) (its `client_id` is an HTTPS URL). Highkey fetches that document over HTTPS only, from public addresses, with no redirects, at most 64 KiB in 5 seconds.
2. The person signs in, chooses the organization the agent works in, and consents to **Read only** or **Read and write** (viewers can grant read only). A read-only grant lists only the read tools.
3. The agent's access tokens last 15 minutes, are bound to `/mcp` and name the organization; it refreshes them while in use. Every request checks that the grant still stands and that its person still belongs to the organization, so revoking a connection in **Settings → Agents** (owners and admins see everyone's) or removing the member stops the agent at once.

`/mcp` also accepts API keys. `/api/read/mcp` accepts API keys only and lists only the read tools whatever the key allows; scheduled and CI runs, which cannot sign in, use it with a read-only key. Neither address accepts a browser session, and both refuse any request carrying a browser `Origin`.

Agent sign-in needs HTTPS: when `HIGHKEY_PUBLIC_URL` is plain HTTP on a non-loopback address (a server on a private network without TLS), OAuth is off and agents connect with API keys instead.

## Network boundary

- Put a TLS terminator in front of the dashboard and route `highkey.example.com` to it. Keep ClickHouse private; never expose it.
- The ingest app serves only `/api/ingest`, `/api/logs/ingest`, `/api/logs/v1/logs`, `/tracker.js` and `/health`, authorized by ingestion keys. It can have its own hostname or be reached through the dashboard, which forwards those paths.
- Live updates (`/_tako/channels/analytics-changes`) need the session of a member of the organization the stream belongs to.
- The ingest app notifies the dashboard at `POST /_highkey/changes`, authorized by the separate `HIGHKEY_CHANGE_TOKEN` secret.

Verify from a signed-out browser or client:

- `/`, `/events` and `/settings` go to the sign-in page; `GET /api/products` answers 401.
- `POST /api/products` from another origin with a valid session answers 403; a request for another host answers 421.
- `GET /api/read/products` with a read-only key answers 200; `POST /api/products` with it answers 403.
- `POST /mcp` without a token answers 401 with a `WWW-Authenticate` header naming the protected-resource metadata.
- `/tracker.js` loads publicly; `POST /api/ingest` without an ingestion key answers 401.
- `/_highkey/changes` without its secret answers 401.
