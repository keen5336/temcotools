# Persistent browser-provider runtime

Migration `20261103150000_generic_provider_runtime` adds the scoped database
bridge for the generic transport. This is source/software qualification; it does
not qualify a live Route Planner/MARS/WMS identity contract, upstream warehouse
mapping, public browser CSP or operational write. The existing DMP transport is
separate. The pilot still denies live write/print effects.

## Shared configuration and activation

`lib/integrations/provider-runtime.ts` exports shared `(principal, raw)` services
and strict input schemas:

- `configureProviderRuntime` / `providerRuntimeConfigurationInput`: current
  platform administrator, fresh password + MFA. Pins a provider/revision, exact
  enabled site profile/revision and published generic payload/version/hash,
  approved identity and business action versions, bounded JSON identity paths,
  typed identity input, evidenced upstream warehouse and private evidence
  reference. No client authentication or permission claims are accepted.
- `listProviderRuntimeConfigurations` / `providerRuntimeListInput`: current
  `providers.manage`, selected warehouse only. Configuration is not a connection.
- `getProviderRuntimeSetup` / `providerRuntimeSetupInput`: current `workflow.read`;
  takes actual origin/pathname and the existing payload/profile reference shape,
  plus optional provider ID. Returns only owned current-site candidates with
  current provider revision, configuration ID, canonical prospective binding and
  expected pins. No token or operational authority is issued.
- `activateProviderRuntime` / `providerRuntimeActivationInput`: explicit human
  owner in a current individual session; MCP gets a handoff. Pins the exact
  configuration, actual page, payload/profile reference and external device/tab.
  Returns the immutable activation, original actor and final canonical binding.
  The coordinator's existing private broker control then issues its one-use token.

Profile version is `profileId:revision`. Final configuration version is
`configurationId:activationId`; a prospective setup candidate has only the
configuration ID until activation. This difference prevents a previous socket
from surviving reactivation of the same configuration/session/device/tab. The
browser must use the final server-returned binding for pairing. Queued, dispatched
or unresolved-unknown work blocks reconfiguration/reactivation; it never migrates
to a new provider incarnation.

Every version is loaded from current enabled publication and checked against its
immutable definition hash and protected approval. Request mappings, constants,
typed input/output, semantic effect, capability, adapter, origin/page/request
boundary and identity/warehouse contract references must still match. Payload
source/hash, advertised named keys, enabled exact profile, protocol and published
version must match too. Identity configuration supports reviewed JSON paths only;
no RP identity endpoint, numeric status or hidden identifier meaning is supplied.

## Broker bridge and private reporting

`createProviderRuntime({audience, mode, reportSecret})` returns `authorize`,
`operations` and `observe`. The coordinator passes these directly to the generic
hub. `providerRuntimeAudience()` uses explicit `INTEGRATION_RELAY_AUDIENCE`, or
purpose-separates the existing DMP audience with `:integration`.
`deriveProviderRuntimeReportSecret()` derives a private purpose/audience HMAC key
from the pilot's existing `SESSION_SECRET`; no new public key/token or account is
created. That server-only value is never an action argument or response. Preserve the existing private report-key namespace during rotation/recovery while old receipts remain outstanding; replacing its key cannot recover old report capabilities.

`authorize` reloads current requester and original owner sessions, access
versions, memberships, current capabilities/client scopes, exact named action
versions, source/identity/warehouse evidence and current profile/payload pins.
Another tab/session/device or OAuth client needs an explicit current named-action
and effect grant; same-person login alone is insufficient. Grants and device links
are locked/rechecked in the writer. The original document's device/tab context is
server-loaded by activation. An ordinary operation request cannot claim it.

`observe` accepts actual hub stages `attach`, `identity`, `renew`, `end`, binding,
optional verified identity, socket nonce and reason. Heartbeats renew only the
established original provider after current owner/session/config checks; they do
not extend the person's idle/session authentication limits. A foreground Temco
page is unnecessary. The exact socket nonce is retained in private observation
metadata and checked on enqueue/claim/end, preventing a stale socket's teardown
from downgrading its replacement. After session revocation, no membership is
restored merely to update status: the broker's disconnected state and expiring
stored heartbeat remain authoritative.

Operations use real scoped Prisma transactions. Enqueue and claim lock the
original provider, recheck current requester/owner/grants and canonical mapped
request inside that writer, compare immutable fingerprint/revision/incarnation,
and enforce bounded queued count plus one in-flight/unresolved-unknown operation.
A partial unique database index also prevents two dispatching operations on one
provider. A committed dispatch is never automatically requeued after restart.

Result retention has a separate narrow capability. Only a digest of a private,
purpose-separated per-operation HMAC token is stored. The broker reconstructs
that token for its exact audience/site/operation after restart.
`temco_integration_report` is a restricted SECURITY DEFINER function accepting
that token and exact operation/provider/socket/request correlation. It can read
that private receipt, CAS a terminal result, or append at most four deduplicated
late-evidence records. It cannot enqueue, claim, change attribution or request,
restore a session/membership, or turn a terminal result back into queued work.
Normal operational ORM remains under forced site RLS. A wrong key/site/operation
returns no record. The capability never reaches a WebSocket frame, UI, MCP,
ordinary receipt or log. This retains a late result after revocation without
restoring dispatch authority.

## Receipts, cancellation and reconciliation

`listIntegrationOperations` and `getIntegrationOperation` expose only the current
person's selected-warehouse history, with current view/action capability checks.
They load the **original immutable definition**, so disabling or updating current
publication does not hide an unknown receipt. The raw private body is retained.
The receipt view reports output validation separately: string contracts accept
raw text/XML; other contracts parse JSON and use the existing strict typed output
validator. Only valid output gets `parsedValue`. Invalid/misleading/error bodies
do not change `reported`/`unknown`, claim success or cause a retry. An HTTP/body
report still does not prove a business or physical effect.

`cancelIntegrationQueuedOperation` / `integrationOperationQueuedCancelInput`
requires current original actor/site and original action capability, plus stable
command ID. It CASes only a never-dispatched queued intent to cancelled, even
without its old socket/current publication. It cannot cancel a dispatched outcome
as though no effect happened. No new provider or request is created.

`reconcileIntegrationOperation` / `integrationOperationReconcileInput` requires
current `office.decide` and `workflow.read`, fresh password + MFA, exact operation,
stable command ID, outcome (`verified_applied` / `verified_not_applied`) and actual
private evidence. Unknowns have no arbitrary maximum age. A stale `dispatching`
receipt can first become unknown only after its original approved timeout plus
five seconds; request correlation is preserved. There is no resend.

The original unknown remains immutable history. A separate signed immutable
`office_resolution` evidence record records authority, actor/session and verified
outcome. A per-operation report token cannot forge that purpose-separated office
signature. Queue/activation gates recognize only a valid server-signed resolution;
a body boolean or forged late evidence cannot clear uncertainty. Resolution does
not reconnect a socket or automatically execute any sibling intent. The human
explicitly reconnects after resolving/cancelling original work.

## Verification

Run the existing isolated database at
`127.0.0.1:55439/temcotools_v2_warehouse_scope_test` with migration35, then:

```sh
WAREHOUSE_SCOPE_TEST_DATABASE_URL='<private local test DSN>' \
  dev-run -- npx tsx --test scripts/provider-runtime.integration.test.ts
```

The fixture refuses other hosts/ports/database names. It uses synthetic identities,
real PostgreSQL RLS/transactions/immutable tables/report function, real WebSocket
and loopback HTTP, the existing broker's authenticated internal control, actual
OAuth-scoped synthetic grants and shared application actions. HTTPS synthetic
origins are mapped to loopback only by an injected test fetch. It checks human
MCP handoff, explicit sharing/revocation/site scope, typed JSON/XML views, disabled
history, offline queued cancellation, lost ACK/restart/late reporting after session
revocation, wrong report key, forged resolution rejection, stale crash recovery
and preservation of the synthetic login hash. It sends nothing to a real upstream
or printer and does not access/reset Adam's account. Immutable synthetic test
history remains in that isolated database; failed diagnostic receipts are retained.
