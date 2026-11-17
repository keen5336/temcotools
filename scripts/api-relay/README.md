# Managed API relays

Open **Configuration** from Relay Mode or your account menu. Install **Connect
Temco** once, then run it on a signed-in external system. It sends only the
page's origin and pathname to the loader, without a referrer, query string,
fragment, DOM content or cookies. The server selects one enabled matching relay
and serves its current injection code. Unsupported or ambiguous pages refuse
injection. The script checks the actual tab before running admin-authored code.

Choose **Connect** in the injected panel and approve the Temco account shown in
the pairing window. Keep that external tab and a signed-in TemcoTools tab open.
Your dashboard and header show each system's status across tools. Configuration
lists connected tabs, upstream account identifiers, and disconnect controls.
External pages must allow the script, WebSocket and popup under their CSP/COOP
policies; this feature does not bypass those policies.

## Administration

Only current, active **administrators** can read or save `/admin/api-relays` and
its `/api/admin/api-relays` API. Manager access to printers/templates does not
grant relay management. Definitions contain:

- A stable ID and display name; an explicit enabled flag.
- Exact HTTPS origins (no wildcards or paths) and a canonical pathname prefix.
  `/ops` matches `/ops` and `/ops/orders`, not `/ops-other`. Overlapping rules
  for the same origin are rejected, including disabled rules.
- A site-relative GET endpoint returning signed-in identity JSON and its stable
  account ID field, such as `subject` or `user.id`.
- Named operations with labels, HTTP methods, relative paths, optional headers,
  JSON body templates, scalar defaults and timeouts.
- Injection JavaScript defining `function startTemcoSiteRelay(config)`. The
  default calls `startDmpRelay(config)`, the shared, system-independent browser
  executor. Customize the function to add site-specific UI/setup. This source
  executes with the external page's privileges. It is public loader code and
  must contain no credentials or private server configuration. The server
  compiles it for syntax without executing it; compilation is not proof of
  behavior on a particular external site.

Save explicitly applies one revision. A stale editor gets a conflict. Each
successful save records the actor, complete snapshot and operation ID in
append-only history. Loading history creates a draft; save it to make a new
revision. A repeated identical operation ID returns the original receipt. An
uncertain response requires reading current state, with no automatic save retry.
New definitions start disabled. Disable a definition and save to stop new
connections/dispatch. Old installed code must reconnect after a revision change.

Until an admin saves `dmp`, the existing `DMP_ORIGINS`, `DMP_IDENTITY_PATH`,
`DMP_IDENTITY_SUBJECT_PATH` and `DMP_API_OPERATIONS` settings define virtual DMP
revision 0. Reads create no rows. A saved DMP definition replaces these defaults,
including when it is disabled. The default origin remains
`https://dmp.extapps.homedepot.com`, identity `/identity/me` field `subject`, and
DMP deliveries for location `5288`. Existing DMP-only bookmarks still use the
current DMP definition; install Connect Temco to activate other systems.

## Named operations and other pages

```json
{
  "lookup": {
    "label": "Look up order",
    "path": "/api/orders/{orderNumber}"
  },
  "search": {
    "label": "Search inventory",
    "method": "POST",
    "path": "/api/inventory/search",
    "headers": { "Content-Type": "application/json" },
    "body": { "query": { "$param": "query" } },
    "timeoutMs": 30000
  }
}
```

These example endpoints require qualification against the intended system.
Path parameters are URL-encoded; `$param` body values retain their scalar types.
Callers cannot choose arbitrary methods, destinations or authentication headers.

Every Temco client page under the shared layout can use `useApiRelays()` from
`components/api-relay/ApiRelayProvider.tsx`: `status`, `refresh`, `disconnect`,
and `request(connectionId, operationName, parameters)`. The API Relays tool is a
generic operation workbench, retaining the DMP delivery date/location controls.
For a server-side domain route, derive `RelayOwner` from the authenticated user
and `apiRelaySessionId`, then call `requestViaRelay()` in
`lib/api-relay/service.ts`. Never accept a caller-supplied owner or use the raw
broker control API to bypass current definition validation.

## Ownership and dispatch

Connections belong to the paired Temco user and creating login session. Other
sessions of the same user can see/use them; other users cannot list, request or
disconnect them. A 256-bit pairing token is hashed in memory, exact-origin,
single-use and expires after 90 seconds. The popup verifies its opener, nonce,
site and current definition revision. Tokens appear only in postMessage and the
first WebSocket frame, never a URL or browser storage.

The shared provider checks status/renews its session lease every 10 seconds,
independent of menu or page visibility. A lease lasts two minutes and each
connection lasts at most eight hours. Logout revokes that login's connections.
Loss of all Temco tabs or background timer suspension can expire the lease.
Unknown broker availability clears confirmed status rather than showing stale
connections as online.

The broker obtains fresh authorization from the app before redeeming a managed
pairing and before every job leaves its queue. Disabled/changed rules, inactive
users, missing authorization or an authorization outage prevent dispatch. Work
already sent may have affected the external system; it is never replayed.
The external executor also checks the actual page origin/path before fetching
and verifies upstream identity initially, periodically, and before/after calls.

Four requests can run per tab, with at most 32 pending, bounded queue/request
timeouts, cancellation, out-of-order IDs and 2 MiB text/JSON responses. Redirects
and off-origin paths fail. Authentication cookies stay in their original tab.
No request or response is persisted. Re-running the bookmark cannot replace an
executor with in-flight work; it asks the operator to wait for the original
result. Disconnects, timeouts and errors cause no automatic retry/reassignment.

## Local setup and future deployment

Apply migration `20261117020000_managed_api_relays`. Run the app and
`npm run api-relay` with the same `SESSION_SECRET` (at least 32 characters).

```dotenv
API_RELAY_PUBLIC_ORIGIN=https://temco.chronchive.com
API_RELAY_INTERNAL_URL=http://api-relay:3003
# On the broker; used for current binding/account checks:
API_RELAY_APP_URL=http://app:3000
```

The broker no longer requires a static DMP-origin list; a live one-use pairing
token admits a managed origin, and the app revalidates its definition. In local
development, HTTP loopback origins are allowed; a production HTTP fixture needs
explicit `API_RELAY_ALLOW_LOCALHOST=1`. Production requires HTTPS by default.
The development executor uses port 3003, overridable by
`API_RELAY_PUBLIC_PORT`. Configure the public origin when using another app port.

Compose keeps the broker on loopback. Caddy must route the existing exact
`/api/api-relay/ws` path to the broker and all other routes to Next. Never expose
`/control`; the internal authorization route requires the derived control key
and returns 404 without it. Deploy the app and API relay broker together at the
same revision in an authorized maintenance window. This change has not been
rolled out and makes no live external-system or physical-printer acceptance claim.

Run `npm run test:api-relay`, `npm run test:relay` and `npm run test:favorites`.
For PostgreSQL tests, apply all migrations to the disposable fixture database
and set `API_RELAY_TEST_DATABASE_URL` to `relay_qa` at `127.0.0.1:55475`.
