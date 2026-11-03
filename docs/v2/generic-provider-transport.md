# Generic browser-provider transport core

This package supplies an executable, bounded transport, independently qualified
with synthetic WebSocket/HTTP fixtures. The post7d source integration adds the scoped
Prisma bridge, shared UI/MCP commands, explicit human popup and pilot-only broker
entrypoint. **Deployment/current pins are recorded in build-status.md; the standalone
core tests do not qualify those integration seams or a live upstream adapter.** It
qualifies no Route Planner/MARS/WMS identity or endpoint. Existing DMP transport
and grants are untouched. The coordinator must supply the bridge below before
any generic live provider can become available.

## Core exports and wire

`scripts/api-relay/generic-provider.mjs` exports
`createGenericProviderHub(options)`. It returns `pair`, `attach`, `renew`, `list`,
`disconnect`, `prepare`, `claim`, `result`, `cancel`, `revoke`, `handleUpgrade` and
`close`. It owns an independent no-server WebSocket server for the exact future
path `/api/integration-relay/ws`. It creates no HTTP listener or public control
route. Mount it deliberately in the existing broker; its own HTTP control
operations must remain internal and authenticated.

`lib/integrations/browser-executor.mjs` exports
`createBrowserProviderExecutor({expected, send, fetch, location, parseIdentity,
onStatus, clock})`, plus portable strict origin/path/request/binding validators
and the bounded JSON identity parser `readProviderIdentity`. The executor exposes
`handle(message)`, `stop()` and `busy()`. An established original socket heartbeat may renew only its current owner lease and request a separately correlated approved identity refresh; it creates no business intent. Its caller owns explicit human
activation, socket creation and pagehide/socket-close cleanup. It never logs in,
approves sharing, reconnects automatically, stores a token, captures DOM, invokes
a camera, evaluates code or selects a different provider.

The human-installed approved payload must supply expected exact origin/page,
audience/integration and immutable adapter/configuration/profile/payload/hash
pins. The executor independently checks its **actual** `location.origin` and
`location.pathname` at initialization, pairing and before every fetch. No query,
fragment or full page URL is reported. Page context is not authentication.

Pairing uses a random, short-lived, one-use token in the **first WebSocket frame**,
never a URL. The frame contains audience, integration, warehouse, pathname and
installed payload/profile pins. The HTTP upgrade checks exact Origin and exact
path; attach also checks all token bindings. Origin alone grants nothing. A DMP
connection/grant cannot act as a generic provider's pairing or sharing authority.
A provider ID has one original socket incarnation; replacement does not move
queued or in-flight work. Never expose pairing tokens in logs, git or diagnostics.

After `paired`, the browser executes the supplied **approved named identity READ**
and returns its bounded body/status, not cookies or headers. Both browser and
server independently parse the evidenced identity/warehouse result. Only matching
actual identity and an approved upstream warehouse binding produce `ready`.
Every business request probes identity before and after execution. The built-in
parser supports bounded JSON field paths. A separately reviewed XML/text identity
parser may be supplied as trusted adapter code; no untrusted selector/eval or
invented identity path is provided. XML/text business bodies are passed unchanged
within their approved byte limit, regardless of misleading Content-Type.

The browser accepts only a named action version from the pinned provider. A
request contains only exact origin, relative path, method, optional mapped body
and JSON/form Content-Type, timeout and response limit. Arbitrary headers/URLs,
credential headers, redirects and origin changes are rejected. Fetch uses
`credentials: same-origin`, `mode: same-origin`, `redirect: error`, `cache: no-store`.
Only body/status/bounded Content-Type return. Raw Cookie/Set-Cookie, auth headers,
browser storage and session material are never captured/exported. Qualification
must establish that the selected response body itself is safe and appropriate;
this transport is not an automatic secret scrubber. Sites requiring an unknown
CSRF/token/header contract remain unavailable until an evidenced adapter exists.

## Required current-authority bridge

Construction requires a nonempty independent audience, a mode
(`read_only_dmp`, `live`, `synthetic`), an async `authorize(context)` and durable
`operations` callbacks. There is no default allow. Keep the pilot mode enabled.
`read_only_dmp` means **semantic reads only**, even for non-DMP integrations: a
qualified read POST is allowed; a write GET or print POST is blocked. Synthetic
contracts cannot dispatch in a live/pilot hub, and synthetic hubs require explicit
synthetic contracts. Test fixtures exercise approval facts without qualifying any
actual upstream contract.

`authorize` receives stage, audience/mode, authenticated actor, original provider,
immutable binding/identity, and where relevant the exact action version, typed
input and original durable operation. It must load/recheck current actor and
owner sessions, memberships, warehouse/site state, capabilities, human activation,
explicit session/device/client/role grants and revocation, lease, enabled approved
action/configuration/profile/payload versions, identity/warehouse evidence and
named-action readiness. The status callback must explicitly return `actionReady: true` and optional bounded `actionReadiness` facts; connected/identified alone never marks actions ready. Identity receipt time is supplied separately for freshness checks. A reported actor, approval boolean or page location is
not that evidence. Reuse the shared current-authority/principal/policy services.
MCP may operate a separately explicitly granted established provider; it cannot
activate/login, approve its own sharing or borrow another user's session.

The callback returns `{allowed: true, binding, action?}` from **server-loaded
facts**. Pair additionally requires its server-established `humanActivated` fact.
`binding` contains provider/site/integration/audience, original owner user/session/
device/tab/authVersion, exact origin/page prefix, immutable configuration/adapter/
profile/payload/hash pins, allowed action version IDs and the approved identity
contract. `action` contains immutable version/key, semantic effect, protected
approval ID/mode/evidence/request-contract hash and the server-mapped concrete
request. Generate it from stored typed definitions; never accept it from an
ordinary UI/MCP client. Existing integration definitions' request-contract hash
protects RPC constants/typed fields when reusing a read approval.

Enqueue and claim invoke the callback again **inside the supplied writer's
`recheck(transaction)` closure**. Pass the writer's actual transaction so current
principal/grant checks and row locks share the atomic intent operation. Reject
any changed mapping or pins. This core does not replace the current-authority
service with an in-memory permissions map.

## Required durable operations bridge

All operation receipts live in caller-supplied durable storage. The hub's maps
are ephemeral sockets, tokens and timers only; none is asserted as a durable
receipt. Implement these callbacks through the existing private database/audit
services, using `(siteId, operationId)` uniqueness and the originating actor/run/
step attribution the application owns:

| Callback | Required behavior |
| --- | --- |
| `get({siteId, operationId})` | Return the original private scoped receipt, including its revision/request correlation. |
| `enqueue(intent, {limit, recheck})` | Under the original provider/queue lock, return an existing identical operation or atomically enforce finite queued count, call `recheck(tx)` and persist immutable request/pins/fingerprint/actor/owner. Conflicting reuse must fail. |
| `claim(key, {expectedRevision, requestId, connectionNonce, maxInFlight, recheck})` | Lock original intent/provider; check queued revision/incarnation, current versions/authority through `recheck(tx)`, and at most one dispatching or unresolved-unknown intent. Commit queued→dispatching with correlation **before** returning `{claimed:true, record}`. Otherwise return the existing record or a reason. |
| `settle(key, {expectedRevision, from, state, result, at})` | Atomic revision/state CAS on this operation only. Preserve original attribution. Return its actual current receipt. |
| `appendEvidence(key, evidence, {limit, dedupeKey})` | Append bounded/deduplicated private late evidence without rewriting the original outcome. Enforce the supplied retention limit durably and return `true` only for retained/already-retained evidence, otherwise `false`. |

The durable intent contains site/integration/audience, original provider and socket
incarnation, actor/owner, complete immutable binding/action, typed input, request
fingerprint, operation ID, state/revision/request ID and timestamps. Add originating
run/step through the integration writer rather than trusting caller-supplied
provenance. The fingerprint prevents changed requests from reusing an operation.
No automatic queue drain or retry occurs; the application's bounded worker may
explicitly claim the next original queued intent after current checks.

States are `queued`, `dispatching`, `reported`, `not_sent`, `cancelled`, `unknown`.
`reported` means a correlated HTTP/body result was returned, **not** proven WMS
success, physical receipt/printing or business completion. An evidenced adapter
must interpret individual results. Cancellation before send is `cancelled`;
after a durable dispatch, cancellation/timeout/disconnect/send uncertainty or any
browser error is `unknown` (even a browser's reported preflight failure is kept
conservatively). There is no automatic mutation replay. Unknown blocks subsequent
claims on that provider. Existing receipts are returned on retry; old socket
intents cannot migrate to a replacement incarnation. A timed-out late response is
retained only as evidence and never silently settles the operation or a sibling.
Storage failure must fail closed. On broker startup, the integration must retain/
reconcile pre-existing dispatching/unknown receipts; never requeue them blindly.

## Coordinator integration checklist

1. Implement the real scoped database callbacks and authoritative binding/action
   loader using existing services. Make current checks part of enqueue/claim
   transactions. Persist private result bodies only within existing retention
   controls; never publish them to logs/git.
2. Bridge established provider observations to persistent registry status. Distinguish
   transport-connected, last identity/warehouse verification time, exact action
   readiness, pending/unknown operation, lease/heartbeat and reconnect reason.
   Do not turn placeholder registration into authentication.
3. Add the separate exact upgrade path to existing broker and approved pilot
   proxy only after review. Do not expose `/control` or internal authorization
   paths. Keep production DMP path/audience/grants isolated.
4. Publish a reviewed payload/loader adapter that installs this executor with
   exact expected pins, explicit human pairing UI and teardown. Existing DMP
   bookmarks remain compatible. An unsupported/unqualified site does nothing.
5. Register narrow shared UI/MCP named commands and human handoffs; no arbitrary
   request, script, URL, projection, grant approval or login tool.
6. Qualify actual private upstream identity/site/read contracts and actual site
   CSP/session behavior before enabling a target. WMS/MARS/printing writes and
   Receiving live trials retain their independent evidence/authority gates.

## Verification and limits

Run `dev-run -- node --test scripts/api-relay/generic-provider.test.mjs`. Tests use
real Node WebSocket traffic and a real loopback HTTP server, plus a serialized,
fsynced file-backed operation fixture that survives hub restart. HTTPS synthetic
origins are mapped to loopback **only by an injected test fetch**; this does not
qualify public TLS, browser CSP/cookies, a distributed lock or the application's
actual database bridge. The fixture exercises separate integrations/sites, token
and actual-page/payload mismatches, explicit requester scope, semantic POST reads,
pilot effect denial, bounded queues/current authority/pin changes, correlated
sibling results, cancellation/unknown/late retention, lease expiry/revocation,
restart/no replay, identity changes and oversized response handling. Header
sentinels are not returned. No real upstream request, deployment, account change,
physical print or warehouse mutation occurs.
