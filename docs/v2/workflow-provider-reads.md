# Workflow browser-provider READ steps

This extends the existing workflow outbox and generic browser transport. It does not add endpoints, guess Route Planner/DMP/WMS mappings or enable receipt/close/printing mutations.

## Supported composition

A published workflow may use a configured approved semantic **READ** action with a declared `providerBinding`. Its action pin contains the exact integration action key, immutable version ID, provider configuration ID, required capability and `effect: "read"`. The contract determines semantics: an evidenced approved POST query can be a READ. Published live contracts run in `application` workflows; synthetic contracts run only in `synthetic` workflows. The established broker independently enforces its own synthetic/live mode and pilot restrictions.

`workflows.actions` lists only current entitled `providerReads` candidates, including the action/configuration pins, typed contracts, provider selector and qualification. An ordinary login never supplies provider authority. A named, current human-approved session/OAuth/provider grant is required even when the connection owner is the same person.

Start input now accepts optional `providerBindings: { upstream: { providerId } }`. These are selectors only. The server resolves and stores configuration + activation, original provider and exact authorization grant IDs. One shared binding used by several steps needs one grant covering all those named versions. Optional `expectedDefinitionVersionId` rejects a publication change between UI review and start; existing callers remain compatible.

Start/operator commands commit `WorkflowIntentRecord` before contacting any provider. Browser READ intents retain their original actor, individual session and optional OAuth grant, plus a server-derived `wfread_…` operation ID. No network operation runs inside a workflow database transaction.

## Execute and resume

The shared `workflows.provider.execute` action uses this strict input:

```json
{
  "runId": "run-synthetic-example",
  "expectedRevision": 1,
  "definitionVersionId": "published-version-id"
}
```

It executes or polls only the retained current intent. There is no caller-supplied URL, operation ID, action, parameters or run attribution. A missing/unqualified/offline provider yields an explicit blocked/readiness result. The service returns `providerExecution.status` as `pending`, `applied`, `blocked` or `retained`, with the original operation ID and an authorized private receipt where available. Poll again with the current run revision; it does not resend a dispatching, reported or unknown operation.

The provider writer reserves the `wfread_` namespace. During enqueue and claim it loads the actual committed intent, immutable workflow version and current run/step under a lock; recomputes mapped inputs; rechecks current original actor, exact grant and action/configuration/activation/provider pins; rejects paused/disabled/settled work. Only that writer adds `workflowOrigin` to the private operation receipt. Arbitrary caller-made run/step attribution is not accepted.

A correlated HTTP 2xx body must validate against the original integration output contract before an executor-origin workflow transition can use it. The transition rechecks current permissions, the original grant and run revision. `succeeded` means the named READ returned typed data, never receipt, movement, delivery, label application or other physical completion. This data can feed later declarative steps through existing bounded mappings.

Pausing/revocation after dispatch does not erase response evidence or fake completion. A result arriving during pause remains in its original private operation. Resume uses that receipt and the original intent. A changed session/client cannot adopt execution. Unknown results remain unknown and require the existing explicit evidence reconciliation; no blind replay or provider fallback occurs. A signed office resolution does not fabricate typed READ output or automatically complete a workflow.

## Independent bounds

Integration responses retain their existing declared byte/type bounds, including body-only XML declared as a string. Workflow step output is independently limited to **64 KiB JSON**, and the bounded run snapshot remains unchanged. A valid larger response stays private and `reported`; the workflow records a clear bounded-output **failure**, not an unknown outcome. Inspect the original private receipt or use a separately reviewed bounded mapping in a later adapter. No XML projection is invented here.

Local/synthetic Receiving, warehouse identifier lookup and confirmed observation commands retain their existing adapters and transaction behavior. Draft testing never contacts browser providers. Live WMS receipt/close, external writes and prints remain unavailable pending actual contracts and trial authority.

## Qualification

`scripts/provider-runtime.integration.test.ts` reuses real local PostgreSQL, the actual private broker HTTP control path, WebSocket transport and browser executor against synthetic loopback HTTP only. It checks committed outbox-before-contact, typed READ → next local step, stable operation reuse after lost acknowledgement, paused queued claims, result retention during pause, grant revocation without substitution, reserved namespace denial, large valid XML versus workflow bounds, unknown custody, and scoped OAuth/shared-action execution. The existing workflow kernel/service/domain suites cover retained Receiving and warehouse behavior.

These are synthetic software checks. They do not qualify a live upstream adapter, confirm warehouse operations or claim actual handheld/operator acceptance.

Source integration: full build `20261103-161824-build-6799`,55 service/kernel/wire checks `161159-build-5726`, scoped lint `161918-build-7036` and7 mobile checks `161924-build-7012` passed. Mobile start review pins the displayed publication, explicit selectors choose a ready original provider, and execution/polling addresses only the retained run intent. Native/public release qualification is recorded separately in [build status](build-status.md).
