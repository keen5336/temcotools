# Configured connections and approved actions

The mobile **Connections and approved actions** page is
`/management/connections`. The globally mounted Connections panel uses the same
current-authority `connections.status` service as MCP. It shows only the person's
own warehouse providers and currently explicit shares; it does not enumerate the
warehouse's browser tabs. Status polling pauses while the page is hidden and
aborts on unmount. The existing DMP setup remains `/tools/api-relay`.

## What is implemented

Integration definitions are stored as a local draft plus immutable published
versions. The JSON editor validates typed inputs/outputs, an exact HTTPS origin,
bounded page/request paths, named adapter/version, semantic read/write/print
meaning, parameter mappings, time/size/concurrency/queue limits and capability.
Preview maps synthetic inputs locally and can validate a supplied fixture output;
it sends nothing upstream. An explicit synthetic example is available in the
editor, rather than inventing any WMS/Route Planner/MARS contract.

A site manager with `integrations.manage` can save definitions within their
current delegation. A **platform administrator with fresh password + MFA** alone
establishes the immutable contract approval: adapter, exact origin/page, endpoint
boundary, method, semantic effect, actual identity/warehouse contract references
and private evidence reference. Server code stamps reviewer, time, approval ID and
request-contract hash. Ordinary draft data or a client `approved` flag cannot do
this. Site publication reuses an approved immutable version of the same action.
The approved request mappings/constants and typed input/output must still match:
a read POST RPC cannot become a delete command by editing a constant or widening
an input enum. Such changes require a new explicit platform review, with no
redeploy. Labels and bounded resource settings may be changed within the existing
contract. Rollback selects an old immutable version; disable and all updates use
current revision checks. Old versions and active intents are never rewritten.

Browser provider registration stores **disconnected, unqualified configuration**.
Its input cannot claim authentication, actual upstream identity/warehouse,
heartbeat or action readiness. The integrated generic transport can execute approved READs after exact configuration and human activation; actual Route Planner, MARS and WMS contracts remain unqualified. See the [WMS LPN quickstart](wms-lpn-quickstart.md). A platform contract review is a saved
qualification decision, not proof that a generic transport has been installed or
that a live call passed. `connections.simulate` validates the selected current
published version and local fixture data, and explicitly reports `sent: false`.

The established DMP relay is queried through its current `getDmpStatus` service;
its compatibility, exact named operation definitions, per-person pairing,
leases, version pins and explicit read-sharing controls are preserved. Broker
transport presence and verified DMP identity are displayed separately from the
still-unqualified upstream warehouse/line/attempt mappings. Generic provider
registration/grants do not create or borrow authority on that legacy connection.
The generic service never copies browser sessions, exports credentials or
performs login/injection. The human opens the supported signed-in upstream page
and activates the stable injector through existing DMP/payload controls.

## Sharing, devices and attribution

The original human provider session can grant exact immutable action versions
and their distinct effect types to one current individual session, one already
consented OAuth grant, or an existing active warehouse role. Current site,
permissions, original session, lease, action publication and recipient capability
are checked. Grants expire (at most 60 minutes, bounded by provider and recipient
expiry) and can be revoked. Sharing and device-link approval require a recent
password/authenticator ceremony. MCP returns a human handoff instead of approving
its own access. Same-account login elsewhere alone grants no provider actions.

Same-person links require two explicitly registered device IDs at the selected
warehouse. Links create no action grant. Routing defaults pin the exact provider
and revision for a requesting device/integration/effect; changing defaults checks
its revision. They cannot silently fail over or grant WMS rights. Revoking a link
also revokes its linked grants. All local writes preserve actor/session/site,
version and ordinary audit attribution with stable operation receipts. Retries
return the original result rather than creating another approval/version.

The separate pure provider-policy module defines the current-authority claim,
no-unknown-replay and physical-printer queue boundary. This service does not
pretend to send generic writes/prints or to confirm any physical effect. Existing
pilot restrictions remain authoritative. Printer transport integration and actual
hardware queue acceptance remain pending; configuring a print action grants no
printer or warehouse authority.

## Shared UI/MCP actions

| Actions | Current authority |
| --- | --- |
| `connections.status` | Active individual account/site; own or current explicit share only |
| `integrations.list`, `.draft.save`, `.validate`, `.preview` | `integrations.manage`, bounded current delegation |
| `integrations.publish`, `.rollback`, `.enabled` | Same, with fresh password + MFA for publication/control changes |
| `integrations.qualify` | `platform.manage` and current platform-admin flag, fresh password + MFA |
| `connections.register` | `providers.manage`; disconnected configuration only |
| `connections.grant`, `.grant.revoke` | Human owner, fresh password + MFA; original provider session for new grant |
| `connections.device.link`, `.device.unlink`, `.device.default` | Human same-person owner, fresh password + MFA |
| `connections.simulate` | `workflow.read` plus selected action's current capability; no external execution |

The coordinator registers these exports in the existing application command
layer; API calls use `/api/application/<action>` and return `{result}` or `{error}`.
Management returns at most 100 records and 500 recent versions; status is bounded
to 200 eligible providers/500 grant candidates and reports `truncated` if its
bound is reached. It does not claim complete estate-wide coverage. No opaque raw
connection status from an unentitled person is returned.

## Verification and operator check

`WAREHOUSE_SCOPE_TEST_DATABASE_URL` must target the isolated loopback
`127.0.0.1:55439/temcotools_v2_warehouse_scope_test`; the test refuses other hosts,
ports or database names. Run:

```sh
WAREHOUSE_SCOPE_TEST_DATABASE_URL='<private local test DSN>' \
  dev-run -- npx tsx --test scripts/integration-service.integration.test.ts
```

This suite exercises real service transactions/RLS with synthetic people/sites,
immutable database versions, local receipts, a synthetic loopback DMP-status
fixture, request tamper rejection, fresh-MFA sharing/MCP handoff, revocation and
routing. It performs no real upstream request, login, print or warehouse action.
It preserves the test database's uniquely named fixture rows because immutable
history is deliberately protected. It does not touch Adam's pilot account.

On the deployed pilot: open Connections on a phone-sized screen, validate/save
the synthetic draft, perform an explicit synthetic platform review, preview its
mapping and inspect version history. Register two synthetic device configurations,
link them, set a default, and verify each still reports unqualified/disconnected.
Use the established DMP connection page independently when a signed-in work
browser is available. Cross-machine live DMP acceptance, generic adapter
qualification, actual device behavior and official-finals comparison are separate
pending checks; no synthetic result qualifies them.
