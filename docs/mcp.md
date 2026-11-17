# TemcoTools v1 MCP

This candidate adds an OAuth-protected HTTP MCP endpoint to the existing web app.
It does not deploy itself or retire a running v2 installation. No extra MCP
container, database credentials in client configuration, or shared API key is needed.

## Connecting

An enrolled, active **administrator** opens Configuration → MCP and copies the
server URL (`https://YOUR_TEMCOTOOLS_HOST/mcp`) into an MCP client that supports
remote HTTP servers and OAuth. Start authorization from that client, sign in to
TemcoTools, check the displayed client ID and callback, and explicitly approve
read-only or read/write access. An existing browser login can be used. The consent
page labels the client name as client-provided; registration is not a trusted badge.

Each approval creates its own MCP device with a 30-day expiration. Access tokens
last up to 15 minutes; refresh tokens rotate without extending the device's
expiration. Reusing a consumed refresh token signs out that entire connection.
Clients must serialize refresh and reconnect after expiration or revocation.
Logging out of the approving browser leaves the separately authorized MCP device
available. Password resets/changes, account-wide sign-out, disabling the account,
and loss of administrator access invalidate its authorization.

Configuration lists your authorized MCP clients, permissions and last-used time.
An authorization is not a live-connection indicator. User Management → Edit lists
the selected user's browser and MCP devices and can sign out one device. The
existing **Sign out all** action remains. Account security also supports individual
sign-out. Device activity timestamps are updated at most once every five minutes.
There is no admin password confirmation or ten-minute administration window.
Changing your own password still requires the current password.

## Application interface

The endpoint supports the current MCP protocol and older Streamable HTTP clients.
It exposes these discovery/execution tools rather than hundreds of separate tools:

| Tool | Purpose |
| --- | --- |
| `application_actions` | Discover actions, optionally by name prefix |
| `application_action_info` | Read one action's exact JSON input schema and effects |
| `application_read` | Execute a read action; rejects write actions |
| `application_action` | Execute an action with the granted permissions |

The original five MARS convenience tool names remain available. Action discovery
includes user/device administration, favorites, shared files, MARS inventory and
audits, Inventory Audit, Pick Waves and staging locations, Scan Lists, Route
Reconciliation, LPN preparation, Report Engine transformations and XLSX/CSV
exports, barcode generation, printer/template management, label printing, API
relay management/requests, and Driver Paperwork preview/publishing.

Native API actions reuse the same application route handlers, identity checks,
validation, conflict/version rules and actor attribution as the UI. Page-only reads
reuse the existing domain services. The catalogue is checked against every user API
route by an independent coverage test. Future user actions must be added there.
Read-only scope cannot call write actions or external relay methods other than
configured GET/HEAD operations. An external system can have its own semantics for
GET; the configured relay operation remains the administrator's responsibility.

Use `application_action_info` before calling an action. Native API inputs use
`params`, `query`, `body`, or multipart `files` and `form`; service inputs are direct.
Uploads contain `filename`, `dataBase64` and optional `field` / `contentType`.
`spreadsheets.parse` accepts XLSX, legacy XLS and CSV, returning rows usable by
`lpn.prepare`, `inventory.import` and `reports.execute`. It uses the current official
SheetJS CE distribution, pinned by the lockfile. Pick-wave creation requires a
mapping for every previewed route, including `null` for No Location.

Credential entry/recovery-code delivery, OAuth approval, activating an external
bookmarklet, physical scanner diagnostics, a browser's printer configuration and
print dialog, and browser-local preferences/drafts return an explicit
`requires_user_interaction` URL. Passwords, recovery codes, third-party login
cookies and OAuth approval cannot be supplied/extracted through MCP. Data actions
around those browser/device steps remain available through MCP. For example,
`labels.print` sends ZPL through an already enabled browser relay; the MCP client
cannot register itself as the physical printer relay.

## Writes, uncertain responses and downloads

Every write requires an `operationId` UUID. Preserve that ID and the exact input
after a lost response. The server reserves a durable receipt before dispatch;
reusing the same ID returns the saved response or an explicit pending/unknown
result without dispatching again. A changed action/input with the same ID is
rejected. Use `mcp.operation` and current application reads to reconcile unknown
outcomes. Never automatically send the operation again with a new ID. An operation
receipt is scoped to the authorizing client device; reconnecting does not transfer
old receipts. Publishing relay definitions and Driver Paperwork also requires its
existing native body operation ID and expected revision/version.

Imports are limited to 20 MB decoded per action. Tool requests are bounded at
64 MB and two million input elements; services accept up to 100,000 rows. Large
JSON results and exported files become private downloads, expiring after 15 minutes.
Downloads are limited to 50 MB each, 64 MB per MCP device and 256 MB total. Expired
bytes are removed when a new artifact is allocated. Use the `temco://downloads/ID`
resource or `mcp.artifact` to read bounded base64 chunks until `nextOffset` is null.
Only the originating MCP grant may read its resources. The browser download URL
requires that grant's administrator to be signed in and the source MCP device to
remain valid; URLs alone grant no access. Browser responses are attachments with
no-sniff and sandbox headers, including generated HTML previews/barcodes.

Already dispatched external requests or print jobs can have uncertain outcomes.
Queued label/API work rechecks the requesting device before dispatch; signing out
an MCP client cancels its unsent jobs while preserving another browser's relay.
No automatic replay or reassignment occurs after an uncertain send.

## Protocol and operations

Discovery endpoints:

- `/.well-known/oauth-protected-resource/mcp`
- `/.well-known/oauth-authorization-server`
- `/oauth/authorize`, `/oauth/token`, `/oauth/register`, `/oauth/revoke`

OAuth uses authorization code with S256 PKCE, exact registered callbacks and the
exact `/mcp` resource audience. Dynamic registration supports public and
confidential clients; HTTPS Client ID Metadata Documents support public clients.
The optional `offline_access` scope supports clients requesting refresh access;
it does not add application permissions or extend the 30-day device lifetime.
Metadata fetching rejects non-public/private destinations, pins the validated IP,
requires valid TLS, rejects redirects, bounds response size/time, and respects
cache directives with a one-hour ceiling. Numeric loopback desktop callbacks may
vary the port; other callbacks must match exactly. Bearer tokens are hashed in the
database, accepted only in Authorization headers, and checked against current
account/session/grant state on every request and native action dispatch. MCP does
not accept a browser cookie as authorization. Consent requires a signed-in browser
and exact Origin; bearer clients cannot approve their own new connections.

`NEXT_PUBLIC_APP_URL` supplies the canonical origin. `MCP_ISSUER_URL` can explicitly
set that same public origin. HTTPS is required outside loopback development. The
reverse proxy must forward Host and the OAuth, well-known and `/mcp` paths without
rewriting them. Do not put a second browser-only login wall in front of discovery
or token endpoints. Browser-based clients may require an exact origin in
`MCP_ALLOWED_ORIGINS`; the app origin is always allowed. No wildcard origin is used
for authenticated MCP responses. Public OAuth metadata/token protocol endpoints
support standard CORS without cookie-based authorization.

`LABEL_RELAY_INTERNAL_URL` points to the fixed internal label broker; Compose uses
`http://label-relay:3002`. It is never selected by a tool argument. Deploy the
matching app, label broker and API broker together because both brokers now check
MCP device revocation. The old unauthenticated raw-database stdio command and its
Compose profile are retired; `npm run mcp` explains the HTTP migration and exits.
Update old stdio/SSH client configurations to the authenticated remote URL.

## Future rollout and verification

**This change must remain undeployed until the owner authorizes a rollout.** In
that window, use the normal backup/deploy procedure and apply
`20261117040000_admin_mcp_and_devices` before starting the matching app/brokers.
The migration adds MCP tables and `AuthSession.lastUsedAt`, allows the new MCP
session kind and initializes existing activity from session timestamps. Existing
account IDs, passwords, sessions and operational history are preserved. It does
not require another staff enrollment. Do not run old application images against
the new session model without assessing compatibility. Retiring the running v2
application is a separate operator action, not part of this source change.

Local qualification uses disposable PostgreSQL and a production Next build with
synthetic accounts/data. `npm run test:mcp` runs policy/catalogue tests; setting
`MCP_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55477/mcp_qa` and
`MCP_TEST_APP_URL=http://127.0.0.1:33022` also runs actual HTTP/OAuth and SDK integration
checks. The application uses the synthetic session secret named in that test,
and `LABEL_RELAY_INTERNAL_URL=http://127.0.0.1:33026`; the test creates its own
acknowledging browser-relay simulator and never contacts a printer. Both current
SDK 2 and legacy SDK 1 clients are exercised. This does not establish acceptance
inside a particular hosted ChatGPT/Claude client, on a physical Zebra/printer, or
on production networking.

## ChatGPT and Codex

Use the same remote URL for both clients and authorize each separately. ChatGPT
can use read-only access for monitoring; enable changes when its work requires
responding through application actions. Codex can receive read/write access for
building integrations. This release supplies tools when a client calls them; it
does not create a background monitor or an automatic reaction schedule.

After an approved deployment, add the remote URL through ChatGPT's custom MCP
setup using OAuth. The server supports OpenAI's current CIMD method negotiation
(public PKCE from the supported-method intersection), DCR, per-tool OAuth metadata,
and the optional `offline_access` scope. See [official OpenAI authentication
guidance](https://developers.openai.com/plugins/build/auth).

For Codex CLI, the installed CLI's help and [official MCP
guide](https://learn.chatgpt.com/docs/extend/mcp) support:

```sh
codex mcp add temcotools --url https://YOUR_TEMCOTOOLS_HOST/mcp
codex mcp login temcotools --scopes temco.read,temco.write,offline_access
```

Clear **Allow changes** on the approval page for read-only access. These are
future setup instructions; no client configuration or production connection is
created by this source change. Hosted-client acceptance remains a rollout check.

Candidate validation on 2026-11-17: production build and TypeScript passed;
changed-file lint passed; MCP HTTP/policy tests 15/15, account/authentication 18/18,
label broker 12/12, API broker including PostgreSQL 39/39, favorites 9/9, and Driver
Paperwork 14 passed (its optional PostgreSQL fixture was not run). A populated
pre-MCP schema preserved the existing account and browser-session data through
the new migration. The catalog has 100 actions: 47 read, 43 write and 10 browser
handoffs. These are source/local-fixture checks, not production or hosted-client
acceptance.

Repository-wide lint still reports 11 errors and two warnings in unchanged files.
The production dependency audit reports nine high and five moderate findings in
existing dependency chains; the baseline had twelve high and six moderate, and no
new affected package appears in this candidate. These pre-existing findings are
not cleared by the MCP checks and were not addressed through unrelated dependency
upgrades in this release.
