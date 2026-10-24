# DMP API relay

Open **DMP API Relay** in Operations Tools. Drag its bookmarklet to the bookmarks
bar. On a signed-in DMP page, run the bookmark and choose **Connect**. A Temco
popup asks which signed-in Temco account to connect. The bookmark contains only
the loader URL. The latest executor is served with `Cache-Control: no-store`;
there are no saved pairing credentials or embedded DMP operations in it.

## Configuration

Defaults use the DMP endpoints supplied for this integration. Override these
variables on the **app** service if the upstream changes:

```dotenv
DMP_ORIGINS=https://dmp.extapps.homedepot.com
DMP_IDENTITY_PATH=/identity/me
DMP_IDENTITY_SUBJECT_PATH=subject
API_RELAY_PUBLIC_ORIGIN=https://temco.chronchive.com
API_RELAY_INTERNAL_URL=http://api-relay:3003
```

`DMP_ORIGINS` is a comma-separated list of exact HTTPS origins, shared with the
broker. An identity response must be successful JSON with a stable string or
numeric subject at the configured dot-separated property path. DMP returns
`subject` (user ID) and `email`; the relay binds only the stable `subject` and
does not need the email. Explicitly empty origin/identity configuration disables
pairing. These endpoints were provided by the user; live DMP access has not yet
been verified.

The server owns a registry of named operations. `session` checks the configured
identity endpoint. `deliveries` sends:

```
GET /api/dashboard/v1/driversDeliveries?DeliveryDate={deliveryDate}&LocationNumber={locationNumber}
```

For input `{"deliveryDate":"10/24/2026"}`, location defaults to `5288` and the
date is encoded as `10%2F24%2F2026`. A caller can supply a different location;
the current DMP account's access determines whether DMP permits it. Add or
override operations with `DMP_API_OPERATIONS` (a JSON object):

```json
{
  "lookup-order": {
    "label": "Look up order",
    "path": "/api/orders/{orderNumber}",
    "timeoutMs": 30000
  },
  "search": {
    "label": "Search inventory",
    "method": "POST",
    "path": "/api/inventory/search",
    "headers": { "Content-Type": "application/json" },
    "body": { "query": { "$param": "query" } }
  }
}
```

These paths are illustrative, not verified DMP endpoints. Path placeholders are
URL-encoded; body `$param` values retain their scalar type. Callers provide an
operation name and scalar inputs, never an arbitrary URL, method, JavaScript,
cookie or authentication header. Additional integration logic can call
`buildDmpRequest()` and `apiRelayControl()` from server-side domain services,
using an owner obtained from the authenticated Temco session.

## Local development and deployment

Run `npm run dev` and `npm run api-relay` in separate terminals with the same
`SESSION_SECRET` (at least 32 characters). For local mock DMP pages, a localhost
HTTP origin is allowed outside production. The broker reads environment from
its process; it does not automatically load `.env` when launched directly.
The development executor uses WebSocket port 3003; override with
`API_RELAY_PUBLIC_PORT` if necessary.

Compose includes the separate `api-relay` service, using the app image and
shared secret. Port 3003 is published only to loopback. Caddy must route the
exact `/api/api-relay/ws` path there (see the Caddyfile example), with all other
API paths still routed to Next. Never expose the broker's `/control` endpoint
publicly. Its requests require a derived shared secret; the Next routes check
the current user against PostgreSQL and construct the owner themselves.
No database migration is required. `scripts/deploy.sh` starts the new service
when an explicitly authorized deployment is performed.

## Ownership and request lifecycle

- Connections and their results belong to a Temco **user**, with explicit
  connection selection when several of that user's DMP tabs are connected.
  Another user gets neither the connection list nor access via a guessed ID.
- Pairing uses a 256-bit token, stored hashed in the broker, bound to the
  authenticated Temco user/session and exact DMP Origin. It expires after 90
  seconds and can be redeemed once, in the WebSocket's first message. The
  token is passed by `postMessage` to the initiating DMP window with an exact
  target origin and matching window/nonce; it never appears in a URL or storage.
- A Temco tab renews the creating session's lease every 10 seconds. The lease
  lasts two minutes to tolerate background browser timer throttling. Logout/account switching revokes the session's pairings;
  if the broker is unreachable, expiry provides bounded revocation. Closing
  all Temco tabs or background timer suspension may also expire the lease.
  The broker caps a connection's lifetime at eight hours.
- DMP identity is checked on initial connection, before and after API calls,
  and every 15 seconds. A different identity or failed identity lookup ends
  the connection and aborts outstanding work. The DMP page/session is the
  execution authority; this is not an independent DMP identity attestation.
- Four jobs run concurrently per DMP tab; up to 32 outstanding jobs are allowed.
  Each job gets a server-generated ID, a queue deadline, cancellation, and a
  request timeout. Responses can arrive out of order. There is no replay,
  automatic retry, reassignment, or persistent response history. A timeout or
  connection loss can leave a DMP mutation's outcome uncertain.
- Requests use same-origin credentials, reject redirects, and stay on the
  DMP origin. DMP cookies are not exported. Responses are bounded to 2 MiB;
  the protocol currently carries text/JSON, not binary downloads. DMP-specific
  CSRF headers or token discovery are not configured until its API is known.
- The DMP site's CSP must allow loading the Temco script and connecting to the
  Temco WebSocket. COOP can sever the popup's opener. These policies require a
  live DMP check; a blocked load gives a browser-side error, not a bypass.

Run `npm run test:api-relay` for broker isolation/concurrency and executor tests.
