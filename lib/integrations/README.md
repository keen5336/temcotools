# Approved integration actions and provider policy

These modules are a pure validation/authorization boundary. They make no network
requests, establish no upstream login, create no grants, and operate no printer.
They do not qualify any WMS, DMP, Route Planner or MARS endpoint. The tests use
synthetic origins and fabricated identities only.

## Definitions

`validateIntegrationAction` accepts a bounded, versioned action document. It has
an integration and adapter identity, exact HTTPS origin, bounded page path,
semantic effect (`read`, `write`, `print`), required capability, typed inputs and
output, same-origin request mapping and resource limits. Paths cannot change
origin, traverse directories or acquire a query/fragment from a path input.
Inputs are strict JSON values without coercion. No expression language, code,
custom headers, credential fields or arbitrary remote URL is supported.

`mapActionRequest` maps only declared inputs, literal JSON values and an
independently verified upstream warehouse value. Bindings may select a nested
input or explicitly serialize a scalar array as CSV/JSON. Body encodings are
JSON and form-urlencoded. An evidenced adapter parses the upstream response;
`validateActionOutput` then checks the declared typed output. XML parsing and
system-specific identity/status interpretation belong in that adapter, never in
untrusted mapping code. New protocols/parsers can require code; routine approved
path/input mapping changes can remain versioned data.

`integrationActionHash` hashes the normalized definition with deterministic
SHA-256. Draft editing, publication, rollback and disable are persistence/service
operations. Rollback selects a previously approved immutable version; it must not
rewrite old versions or replace versions pinned by queued work.

## Trust comes from server persistence

`StoredActionVersion`, `StoredActionPublication`, `StoredContractApproval`,
provider/grant/link rows and the current actor/owner facts are **server-loaded
records**, not UI/MCP parameters. TypeScript interfaces are not proof that a row
is trusted. An ordinary client's `mode: live`, `approved: true`, `siteId`, reported
page location, or supplied capability list grants nothing.

The shared server service must establish publication authority, protect immutable
version and contract facts, and independently load current site membership,
session/client grant, capabilities and group membership. Contract approval is a
separate protected platform-admin review recording private evidence references,
adapter version, method, exact origin/path, semantic effect, identity contract
and warehouse-binding contract. Site publication cannot promote a draft or
synthetic contract to live. Evidence references identify private evidence, never
contain raw credentials/customer payloads.

HTTP method is not the effect classification: a POST can be a read only when its
separate approved live contract establishes that meaning. Conversely a GET
classified as a write remains blocked in read-only pilot mode. The pure policy
cannot determine whether an administrator's evidence is true; the protected
review service owns that qualification. A synthetic provider runs only in
`dry-run` and cannot dispatch to a browser/printer provider.

## Provider selection and execution

`canViewProvider` exposes same-person, same-site connection status and explicitly
shared status. Visibility grants no action authority. `chooseProviderRoute`
selects one explicitly configured person/device/site/integration/effect default;
it never grants execution and never chooses a different provider when the
selected one is unavailable.

`decideProviderDispatch` returns an actionable blocked reason/fix, an existing
receipt with `mayRedispatch: false`, or a ready decision. It rechecks:

- Current person, warehouse, membership, session/client grant and capability;
  current original provider owner's session, site membership and named actions.
- Exact immutable publication/contract/action, integration and provider pins.
- Provider lease/revocation, transport heartbeat, actual verified upstream
  identity and warehouse binding, independently checked real page, and readiness
  for this named action. Connected transport alone is not authenticated/readable.
- Explicit named-action/effect grants for another tab/session/device or MCP
  client, even when the person is the same. A user grant must bind a receiver
  session, device or OAuth grant. Group shares require current group membership.
  Query, write and print effects remain distinct. Same-person device links can
  support revocable routing grants but do not authorize actions alone.
- Original run/step site and all pinned action/provider/config/adapter/profile/
  payload versions, request identity and bounded queue/concurrency state.

Original provider owner/session/device/tab, requester/session/client grant,
explicit share, site, run/step and selected versions remain in ready attribution.
The page-reported origin/path is dispatch context, not authentication. The
installed adapter must check its actual location and use its independently
qualified identity/site operation; a DMP identity or grant never qualifies Route
Planner or MARS.

### Durable dispatch sequence

1. Load current server facts and call the policy in `prepare` phase.
   `execution: enqueue` authorizes persisting an intent, **not sending it**.
2. Persist the immutable request hash/pins/attribution and unique operation ID.
   The durable queue has a finite configured limit. For no-buffer actions a full
   provider prevents enqueue; buffered actions may queue behind in-flight work.
3. In the dispatch writer, reload current authority/provider/grants/versions,
   recompute the decision with `phase: claim` and expected operation revision,
   and atomically compare-and-swap the original queued receipt to dispatching.
   Commit the intent before contacting the provider. The queue/slot claim must
   be atomic; these pure functions do not provide a lock.
4. Only `execution: dispatch` from that claim permits the transport call.
   Record returned results against the original intent. Lost acknowledgement,
   disconnect after dispatch or other uncertain outcome becomes `unknown`;
   never automatically replay, reroute or generate a replacement operation ID.

Retries of dispatched/failed/succeeded/unknown operations return the existing
receipt, not another dispatch. A queued retry may only advance through the
revision-checked claim path. `canReadOperationReceipt` permits scoped retrieval
even while the provider is offline; use a server-chosen view capability. A
workflow may explicitly buffer local observations while an effect provider is
offline, but that is separate from permission to enqueue/dispatch that effect.

## Physical printer queue

`decidePrinterClaim` requires a current claimed print-effect decision, the same
physical printer/provider, requester and original operation/run/step. It enforces
queue order across all provider aliases of that physical printer. Load unresolved
jobs under one physical-printer lock (including conflicting aliases across sites)
and CAS the queued revision in the same transaction. Do not hide other-site
conflicting jobs from the queue decision or expose their details to the requester.

An in-flight or uncertain sibling blocks subsequent output. Acknowledged network
output is not physical printing; only an explicit physical-confirmation fact can
set `physicalPrintConfirmed`. Retrying acknowledged/unknown jobs never sends them
again. Failed output requires a deliberate new authorized reprint decision, not
automatic replay. Printer delegation grants no WMS authority.

## Minimum persistent records for integration

The coordinator's shared services need the following durable facts, using
existing tables/services where possible:

- Integration adapter identity; immutable action versions; publication pointer/
  disable state; separate protected immutable contract approvals/evidence refs.
- Site-bound provider with original owner/session/device/tab, exact version pins,
  lease/heartbeat/error state, independently established identity/site/location
  and named-action readiness. These are server-updated observations.
- Explicit expiring/revocable provider grants, site/group membership, same-person
  device links and revisioned per-device routing defaults.
- Unique operation receipt/intent with requester, site, version pins, request
  hash, original run/step, revision and queued/dispatching/result/unknown state;
  an atomic provider concurrency/queue claim.
- Physical-printer identity and coordinated queue jobs preserving requester,
  provider, operation/run/step, position, revision and uncertain/physical outcomes.

UI and MCP must invoke the same scoped persistence/command service. Do not expose
`MappedActionRequest`, trusted record interfaces or contract approval flags as an
ordinary arbitrary-network tool. No database/API integration, live upstream
qualification or physical device acceptance is claimed by this package.

## Focused verification

Run `dev-run -- npx tsx --test scripts/integration-definition.test.ts` from the
external worktree. The finite synthetic cases cover mappings/input/output bounds,
origin/path changes, publication/evidence separation, semantic POST reads,
current site/owner/client authority, explicit sharing/device links, stale pins/
leases/readiness, existing/unknown receipts, queue backpressure, no provider
failover, and requester/run-bound physical-printer serialization.
