# TemcoTools v2 strategy

Planning baseline: 2026-10-31, GitHub [`keen5336/temcotools`](https://github.com/keen5336/temcotools), published `main` and preserved version-one baseline `v1` at `fea1f22af1b2fae788388f2aefed3e3998e98d09`. This document records the agreed direction; implementation/tested state is tracked in [build status](build-status.md). Read with the [implementation plan](implementation-plan.md) and [bounded open questions](open-questions.md).

## Direction and boundaries

Make the existing application the warehouse's shared operational workspace. Keep the processes that work, connect their data and actions, and replace Report Engine's role with useful saved operational views. Home should answer: What needs attention now? What should I do next? How far through today's work are we?

Zebra Android handhelds are the primary interface. Ordinary phones must work, and an operations manager should be able to administer essentially everything from a phone. Desktop exports remain useful. Preserve scanning speed, label printing, spreadsheet imports and historical evidence throughout incremental migration.

Use the existing Next.js/React/TypeScript/Tailwind application, Prisma and PostgreSQL, plus the existing DMP and printer relays. No Citadel, ClioDB, NATS, Quill, new platform, generic workflow engine or wholesale rewrite is proposed. Receiving cutoff timing is outside the immediate problem.

Standing build mandate, 2026-10-31: implement, test, review, correct, commit and push the agreed v2 build continuously on `v2`, advancing useful unblocked work until completion or a genuine owner-dependent blocker. This supersedes the initial documents-only assignment; no separate implementation assignment is required. Existing relevant read-only source/integration inspection is authorized. Production deployment/data changes, paid provisioning, DNS/mail changes, real email sending and live operational mutations remain outside this mandate. Keep actual customer data, credentials, production payloads and private operational notes out of this public repository. Examples below are synthetic.

Continuing owner authorization, updated 2026-10-31: Codex may use focused, bounded subagents when effective in later TemcoTools v2 planning/build tasks. This supersedes the original single-agent restriction. Inherit GPT-6.1 Sol with `reasoningEffort=xhigh`; no model substitution is authorized. The main thread owns integration and synthesis. Avoid duplicate investigation, delegation overhead and tests that merely test test infrastructure. This permission does not expand deployment or external-action authority.

## Source-grounded current state

The isolated `v2` worktree and original `main` checkout both started clean at the baseline above. Live remote inspection found `main` and `v1` at that same SHA, no remote `v2` yet, and no unpublished original-checkout commits. There was no local DMP drift to copy. These are inspection-time facts, not a future guarantee; recheck before implementation. No secret/config files or production data were inspected.

[`package.json`](../../package.json) pins Next.js 16.2.2 and React 19.2.4 and declares Prisma 7.6, TypeScript and Tailwind. The following code, rather than the older `REPO_MAP.json`, grounds this plan:

| Existing seam | Verified behavior and consequence |
| --- | --- |
| [Tool catalog](../../lib/tools.ts), [Home](../../app/page.tsx), [dashboard](../../components/tools/ToolDashboard.tsx) | Home is a role-filtered catalog with persistent favorites and a mobile drawer, not an operational dashboard. Reuse navigation and favorites. Catalog visibility is not server authorization. |
| [Schema](../../prisma/schema.prisma), [LPN parser](../../lib/lpn-report.ts), [Inventory Audit service](../../lib/inventory-audit.ts) | Persistent LPN key, full normalized source row, content hash, revision counter, archive state, transactional import and independent scan records. Identical imports preserve row state; changed fields reset verification/reactivate; absent LPNs remain. A revision counter does **not** retain every prior row version. |
| [Put Away](../../app/tools/lpn-put-away/LpnPutAwayClient.tsx), [workbook parser](../../lib/lpn-workbook.ts) | Separate client upload filters `Placing` rows by received date. It can become a saved view over the shared import. The WMS parser requires LPN, Status, Order Number, Vendor, Received Date, Description and Deliver to; extra columns survive. It does not establish a typed MSN/serial mapping. |
| [Pick Wave service](../../lib/pick-waves.ts), [workspace](../../components/pick-waves/PickWaveWorkspaceClient.tsx) | Workbook import, route-to-staging mapping, scan history, labels and exports already work. `scanPickWave` searches only that wave across LPN/serial/tracking/order/part, then chooses the first unscanned candidate. Reusing this selection rule for global unit identity or finals would be unsafe. |
| [Scanner capture](../../components/scanner/ScannerCapture.tsx), [Scan Lists](../../components/scan-lists/ScanListsClient.tsx) | Focus-free wedge capture, feedback and a serial in-memory processing queue exist; Scan Lists additionally persists a local draft. The capture queue is not durable offline delivery. Pick Wave currently awaits optional printing inside scan processing. |
| [Route Recon](../../lib/route-recons.ts), [report UI](../../components/route-recon/RouteReconWorkspaceClient.tsx) | Saved route-grouped workbook rows and printable reports. No finalized DMP demand snapshot, lane verification or finals sign-off model. Preserve printable output while adding finals. |
| [MARS import](../../lib/mars/import.ts), [audit](../../lib/mars/audit.ts), [reconciliation](../../lib/mars/reconciliation.ts), [classification](../../lib/mars/classification.ts) | Submission-keyed `MarsUnit`, imported status/context, events, physical sightings and saved audit reports. Audit matches request/submission number only. Missing imports mark records locally deleted/archived; duplicate submission rows currently use the last occurrence. The reconciliation and classification helpers use different expectation rules; neither supplies a global unit/attempt/return model. |
| [MARS label client](../../app/tools/rtv-label/MarsLabelClient.tsx), [label fields](../../app/tools/rtv-label/marsLabelShared.ts) | Existing detail-page bookmarklet extracts submission/order/serial fields and prints or opens Temco for review. Submission-number barcodes already exist. This is not an external MARS submission-creation API. |
| [DMP configuration](../../lib/api-relay/config.ts), [control route](../../app/api/api-relay/[action]/route.ts), [loader](../../app/api/api-relay/loader/route.ts), [executor](../../scripts/api-relay/executor.mjs), [broker](../../scripts/api-relay/server.mjs) | Thin loader/current executor, per-user connections and session lease, exact origins, identity checks, named server operations, bounded concurrency/correlation and no automatic replay. Defaults are `session` and `deliveries`; extra operations are configuration, not verified upstream contracts. Results are transient; no shared DMP warehouse history exists in the schema. |
| [Label configuration](../../lib/label-configuration.ts), [management API](../../app/api/management/label-config/route.ts), [printing](../../lib/label-printing.ts), [persistent receiver](../../components/labels/LabelRelayProvider.tsx) | Managed printers and mutable ZPL templates for `mars_return`/`pick_wave`, direct browser and laptop relay modes. Browser `no-cors` completion is not physical print confirmation. There is no durable label issuance/version ledger. |
| [Auth helpers](../../lib/auth/index.ts), [session](../../lib/session.ts), [login](../../app/api/auth/login/route.ts), [user administration](../../app/api/admin/users/[id]/route.ts) | bcrypt PIN login; encrypted cookie contains role/isActive copied at login. Generic guards mostly trust that snapshot. Account/role changes do not invalidate ordinary existing sessions. DMP and [label relay session](../../app/api/label-relay/session/route.ts) routes already recheck active user in PostgreSQL, which is useful precedent. |
| [MCP server](../../scripts/mcp-server.ts) | Five read-only MARS tools over stdio, direct database access, no application user principal or action-level authorization. This is not the owner-required authenticated remote MCP interface. |
| [Report Engine](../../app/tools/report-engine/PipelineBuilderClient.tsx), [pipeline helper](../../lib/pipeline/executePipeline.ts) | Separate client transformation builder, not a shared warehouse dataset. Its join retains one right-hand row per key; it cannot safely resolve multi-unit orders. Owner explicitly reports the tool broken/unhelpful; this turn did not run it to diagnose its UI failures. |

**Owner-verified operational fact:** the DMP integration works very well and must be preserved and extended. Older text saying live DMP was unverified is superseded by that report. This planning inspection made no live DMP calls and does not claim to have verified additional endpoints, response fields, MARS mutations or Ashe's finals rules.

## One running warehouse dataset

Keep five dimensions separate; do not collapse them into one mutable status:

| Dimension | Authority and dates | Example meaning |
| --- | --- | --- |
| Externally reported state | WMS/MARS source, source-as-of, import time and revision | WMS says delivered; MARS says awaiting pickup. |
| Expected movement | DMP requirement/attempt/replacement relationship or authorized office decision; effective day and source-as-of | Replacement should return after a missed attempt; pickup is scheduled. |
| Observed physical state | Person/device, capture time, server receipt time, place and observation type | Seen here; checked in; confirmed in lane; physically departed. |
| Office disposition | Responsible person, reason, authorization, effective interval, next action and conditional review | Reschedule; customer property; hold; RTV if this unit is still here after five days. |
| Label state | Purpose, template/rule/content versions, issuance job and outcome | Needs revised route label; sent with physical output unconfirmed. |

A scheduled delivery/pickup is not a completed movement. Imported delivered/historical rows are not all warehouse stock. A recent scan is positive evidence at its observation time, not a guarantee that the item remains present forever. Show contradictory or stale evidence instead of silently choosing a source. A completed physical departure supersedes older presence for the current physical view while retaining both.

Extend the existing schema with ordinary relational records and a small shared service layer. The names below are proposed concepts, not upstream payload fields or a final Prisma migration:

| Concept | Minimum responsibility |
| --- | --- |
| Physical unit | Stable internal `unitId` independent of LPN, order and submission. Physical identity stays stable through aliases and resubmissions. |
| Identifier/link | Identifier type/value, source namespace, unit, validity/history, evidence and resolved/ambiguous/conflicting state. Namespace serials by available manufacturer/model context; do not assume global uniqueness. |
| Source batch + row revision | Source, scope/day/location, complete/partial coverage, source-as-of/import time and full source row. Retain old revisions going forward and a link to the unit or unresolved match. |
| Order line, attempt, exchange and movement expectation | Order context plus unit/line/quantity, route/day, attempt outcome and conditional relationships. An expected movement may precede unit identification. |
| Physical observation | Original scan value, resolved unit if known, operator/device, purpose, capture/receipt times, actual location, evidence and correction link. Retain unknown/duplicate scans. |
| Case/disposition | Stable issue identity, reason, owner, next action, trigger, permission/authorization and execution history. |
| Dispatch/lane version | Exact DMP requirements, allocations, confirmations, exceptions, signature and amendments. |
| Label issuance / external action | Versioned intent, authority, operation ID, target, dispatch/outcome evidence and uncertainty. |

Use Inventory Audit as the WMS foundation, retaining its LPN keys, full rows and independent evidence. Add history rather than claiming older overwritten rows can be recovered. One accepted WMS import feeds put-away, inventory, pick matching and other saved views. Retain missing rows but mark latest batch membership/scope explicitly. Refreshing a partial export must not mark the whole warehouse absent. A spreadsheet's upload time must not be invented as its source-as-of time.

DMP syncs enrich expectations, likely incoming freight, deliveries and history. An interactive signed-in relay is not an unattended integration: if no authorized tab is available, show the last completed snapshot and stale/unavailable status. Publish a refreshed scope only after the response is validated and complete; do not clear requirements on a failed, truncated or partial refresh. MARS retains its own submission history and imported return/pickup states. An absent submission row is an external-report discrepancy, not proof of physical departure or deletion of the physical unit.

## Identity and history on every scan

Scan any linked LPN, MSN, serial or MARS submission barcode to reach the same physical unit and its timeline: received → delivered/attempted → replacement scheduled → original conditionally expected back → check-in → RTV submission → awaiting/scheduled pickup → physical departure → later external return status. These are events and relationships, not a mandatory linear status progression; attempts and resubmissions can repeat.

Resolve exact typed aliases first, across the warehouse, before interpreting the scan within a task. Normalize per identifier type, preserve raw values/leading zeroes, and allow barcode-type hints. An order number opens context/candidates; it never automatically merges or selects all physical units. Model/part matches support demand allocation, not proof of identity. An ambiguous identifier displays candidates and requests another identifier or an authorized evidence-backed resolution. A correction preserves prior links and observations; it does not rewrite the original evidence. The resolver must be able to split/reverse an incorrect linkage without erasing history.

Original appliance A and replacement B are separate units related by an exchange/order event. A changed submission becomes another external record/alias linked through supported evidence. Do not replace a unit's identity with its newest submission. Existing `trackingNumber` is not assumed to mean MSN. The exact DMP/MARS order–MSN–submission fields and relationships require the bounded evidence work in [open questions](open-questions.md).

## Daily work on Zebra and phones

Home defaults to work the current user can act on: floor staff see scan/pick/staging/finals progress and handling instructions; office users see return/check-in gaps, reschedule cases and aging/watch triggers; managers see priority exceptions, day/lane completion and data freshness; admins also see access, device and integration issues. These are proposed defaults, not owner-approved role names. Authorized widgets can be enabled/reordered per person, building on favorites. Counts link to the exact filtered worklist and show snapshot time, numerator/denominator and unresolved work so a green total cannot hide stale demand.

Use large scan results, text plus color/sound/vibration, stable focus-free capture, one-handed actions, clear current identity/location/day and a persistent queue indicator. Separate administration screens from scan mode so a barcode cannot type into source editing or publish controls. All management flows, including imports, user/device setup, label preview, payload editing/publishing and loader installation, must fit phone width without drag-only controls. Preserve CSV/XLSX/report exports for desktop use.

### One scan, several useful results

The picking pass already touches warehouse items. For each captured scan:

1. Persist/acknowledge the observation once using a device event ID and captured operator/session. Resolve globally; unresolved values remain reviewable.
2. Record presence at the actual observed place. Evaluate pick assignment, staging instruction, label freshness, office watch and RTV eligibility against local saved data.
3. Show the highest-priority actionable instruction plus secondary results. Seeing an item, instructing `MOVE TO LANE X`, confirming placement and completing departure remain distinct records.
4. Queue label/external work separately from scan acknowledgement. Rich DMP history can be requested in detail through the existing relay; every scan must not wait for several live calls or a slow printer.

Reuse `ScannerCapture`; add a bounded persistent device queue for observations, not automatic MARS/print replay. Show captured, saved, rejected and unresolved counts. On network loss, retain pending evidence and label its unconfirmed status. On account switch, quarantine the prior user's unsent queue for that user to resume; never attribute it to the next user. Reauthenticate/revalidate authority before accepting pending events. Retrying delivery of the same event ID must not create a second observation; rescanning intentionally creates another observation, without double-counting fulfillment. Ordinary phone camera scanning/OCR is an optional capture adapter with manual fallback; show OCR candidates for confirmation and do not infer identity from uncertain recognition.

### DMP-generated pick work

Join DMP delivery demand for the selected dispatch day/location to WMS units through evidenced unit/line identifiers and quantities. Allocate specific units transactionally so two waves cannot consume one unit twice. Prefer actual MSN/serial/LPN links where supplied; use model/line/quantity constraints to present candidates when exact identity is unavailable. Missing units, duplicate candidates, conflicting identifiers, quantity mismatches and stale source scopes become explicit queues. An order match alone cannot select every LPN on that order.

Create Pick Waves from the accepted allocations, retaining current scan UI, route staging, labels and exports. Keep workbook import as a visible fallback with source attribution; it cannot silently become official DMP finals demand. A saved route instruction is not confirmation of physical lane placement. Refreshed dates/routes amend outstanding work and label expectations without deleting attempt or scan history.

### Finals verify the actual lane

Finals uses the finalized DMP requirements and rules Ashe uses for official printed finals, for an explicitly selected dispatch day. WMS supports identity and supply matching; it is not the demand authority. Do not label a generic deliveries response “official finals” before confirming that equivalence.

Select/scan lane → scan actual units → validate exact items and quantities. Every scan is globally resolved. A unit unknown to this lane is searched across other lanes, warehouse stock and linked DMP context, with optional on-demand enrichment. A known mismatch displays **WRONG LANE / MOVE TO LANE X** prominently. Preserve the observed source lane; credit lane X only after a new destination scan/placement confirmation. Moving an item out removes its active source-lane credit atomically while retaining the earlier observation.

Duplicates remain in evidence but do not increase quantities. Unexpected known units, ambiguous matches and unidentified scans remain separate exceptions; none silently fulfill a requirement. One physical unit cannot satisfy two lines/lanes. A new broad warehouse scan does not substitute for lane confirmation within the finals session/version.

Store DMP source-as-of/scope, lane/requirement version, each confirmation time, discrepancies, authorized exception reasons and sign-off actor/time. Sign-off checks that the version is still current. Preserve signed-off versions immutably. Later DMP demand, route, quantity or physical-location changes create amendments with targeted rechecks; show affected lanes as needing recheck rather than rewriting an old signature. Unchanged lines retain evidenced confirmations only where the amendment establishes they still apply.

## Durable office cases and expected returns

Create a scheduling case when evidence supports **physically present stock + past delivery date + no new date**, and an aging case for stock in the warehouse over 20 days. Use warehouse business dates/timezone and explicit source freshness. Unknown/partial DMP coverage cannot prove “no new date.” Count aging from a supported receipt/check-in for the current warehouse stay; where only a source received date exists, label that basis and uncertainty. A missing scan is not a physical departure; a past scan alone is not sufficient after contradictory later movement.

Cases persist across refreshes. A natural key such as unit + issue reason + obligation/stay prevents daily duplicates. Store reason/evidence, responsible person, disposition, next action, due date or conditional trigger, authorizer and execution status. Distinguish unresolved, assigned, watching, authorized, execution pending and resolved. A valid watch/resolution suppresses repeated alerts until its defined condition, expiry or conflicting evidence reopens the same case. A new delivery date clears the scheduling issue and updates pick/labels, preserving the original attempt/case trail.

Example: an office user authorizes another delivery attempt for A and specifies “if A is still physically here after five days, the next qualifying scan routes A to RTV.” Store the deadline, exact unit, conditions, permitted action and expiry/revocation. When a later qualifying physical scan meets that condition, show the existing RTV instruction and permit execution within that authority. Passing five days alone does not prove presence or submit MARS. Execution and label issuance remain separate outcomes. B does not inherit A's authorization.

Expected-return work starts from DMP outcomes, check-in evidence and dispositions, including units with **no MARS submission**. A return expectation records why, which unit/attempt it concerns, when it becomes due and any prerequisite such as a successful exchange. Missed delivery can require reschedule/customer-property handling rather than RTV.

| Work item | What it must explain |
| --- | --- |
| Expected return not checked in | Which delivery/attempt/disposition expects it back; last supported custody and the missing check-in. Do not claim it is physically here. |
| Checked-in RTV unit without submission | Physical evidence and exact authorization/reason for RTV; where the submission trail stops. |
| Submission exists, not seen in audit | Submission expectation and the defined audit coverage/window; do not infer disappearance from unrelated scans. |
| Physically seen, no matching submission | Observed unit, failed/ambiguous linkage and whether RTV is actually required. No-submission is not automatically an error for reschedule stock. |
| Externally shipped/received/delivered but seen here | Conflicting source and observation times; request reconciliation rather than overwrite physical evidence. |

### Critical replacement example

Use synthetic order `ORDER-DEMO-1`, original A and replacement B:

1. A is with the customer. Team takes B for an exchange; A's expected return is conditional on exchange completion.
2. Customer is not home. DMP records a missed attempt. A remains with the customer; its obligation is deferred to a future successful exchange. A is not missing from this failed attempt, and its future obligation is not deleted. B is expected back for rescheduling.
3. **B checks in:** retain operator/time evidence. After refresh next morning, if B's delivery date is past and no new date exists, show **OFFICE: replacement awaiting reschedule**, missed-attempt history, check-in and A's future exchange relationship.
4. **B never checks in:** show **expected replacement return not confirmed**, with the trail stopping before check-in. Do not classify B as warehouse stock based on its expected return.
5. A new DMP date clears B's scheduling case and changes its pick/label expectations. Retain the failed attempt. A's deferred obligation carries into the future exchange and becomes due when that exchange succeeds; any RTV rule for A never transfers to B.

## Labels, rules and external effects

Extend current printer management and direct/laptop relay modes. Proposed label purposes include unit identity, put-away/handling, delivery staging, reschedule/office disposition and RTV/MARS. Keep submission-number barcodes and useful existing templates.

A manageable manager has purpose/field definitions, mutable drafts, immutable published template versions, synthetic preview at printer size, selected printer/media, manual print/reprint, automatic triggers, rule priority and publication audit. Record safe field escaping and required fields; a missing submission number blocks a submission label. Operators select approved output, while authorized managers edit templates/rules. Label source code is not bookmarklet source code; payload administration remains admin-only.

Define rule precedence: safety/hold or conflicting identity blocks automatic movement/external action; an applicable unit-specific authorized disposition takes precedence over ordinary pick/handling instructions; current dispatch routing applies when compatible; generic purpose defaults are last. Show conflicting instructions for office resolution. Automatic rules can invoke only named application actions within explicit operator/prior-office authority, not arbitrary code. A rule does not grant permissions. Store rule version and reason with every result.

Calculate a content fingerprint from relevant operational fields (date, route/lane, disposition/instruction and required identifiers), purpose and published template version. A changed relevant field marks a new label due. Irrelevant source-field changes and repeat scans do not. Distinguish `last physically seen`, `label required`, `last issued content/version`, `send outcome` and optional human `label applied/print confirmed`. An unresolved prior print prevents automatic repeat issuance, even if new content becomes due; show review/reprint with the superseding version. Authorized reprints create an attributed new issuance with reason.

Use a small durable action record for UI and MCP: operation ID, input fingerprint, actor/client/device, authority, target unit/printer/submission, captured versions, preconditions, dispatch time and outcome. Local commands may be retried with the same key and return the same result. External sends distinguish not-dispatched, dispatched/pending, externally acknowledged, outcome unknown and reconciled. An acknowledgement can still be weaker than a physical fact. Record physical print/application, pickup/departure and later vendor status independently. A timeout/cancel after dispatch cannot prove nothing happened.

The future MARS button starts with an identified unit and an eligible disposition, checks operator permission or a still-valid exact prior authorization, checks existing/active submissions and locks duplicate attempts before dispatch. Use only evidence-confirmed named upstream operations. Successful creation records the submission identity before offering its label. On uncertain creation, retain the operation identity, block automatic resubmission and reconcile upstream before deciding on a new attempt. A failed print after successful submission must offer that submission's label, not create another submission. If no supported creation interface is confirmed, the button opens the appropriate existing MARS workflow for human completion and records its returned identity; do not claim automated submission works.

## Admin bookmarklet/payload manager

Extend the thin loader/current executor in place. The need is real source/payload management for known signed-in external-page integrations, not a general plugin marketplace or arbitrary remote execution service.

Each named payload has a stable ID/purpose, owner, exact allowed target origins (optionally narrower paths), required capabilities and protocol/operation compatibility. Initial purposes: DMP relay executor and, when migrated, the MARS detail/label helper. Preserve the existing loader URL as an alias to the default DMP payload so installed bookmarks continue to work. New bookmarks load a specific payload ID; central publication changes that payload's next-load version without reinstalling it.

Admin-only management includes source editing, save draft, source diff, syntax/contract checks, synthetic test/preview, immutable version creation, explicit publish, disable and rollback. Preview runs in an isolated sandbox with synthetic fixtures and no signed-in Temco/external-page credentials or live relay authority; it must not evaluate editable source in the admin page's origin or on the server. Actual target-page qualification is a separate explicit action with its own permitted operations. Rollback changes the published pointer to a known immutable version and is itself audited. Use optimistic version checks so two admins cannot overwrite each other's publication. Require recent strong authentication for publishing code or changing origins. Non-admins may run an approved payload only within their permissions; they cannot edit, test privileged source, publish, roll back or widen origins through UI, MCP or a guessed URL.

Resolve the published pointer without shared caching (`no-store`); serve immutable version assets by version/hash. An invocation pins payload version, protocol and allowed operation set for its lifetime; the broker records these. Publishing/rollback affects subsequent invocations. It never replaces code under an in-flight request or replays a mutation. Old loaded executors cannot gain newly added privileges automatically; breaking/security updates require reconnecting, and disable/revocation blocks new work immediately. Where a dispatched request loses its connection, preserve uncertainty instead of assuming cancellation reversed it.

Serving an approved executable asset cross-origin may be necessary because the external tab has no Temco cookie. That asset must contain no secrets, pairing tokens, private data or draft source. Public asset access is not action authority: pairing and dispatch still authenticate the Temco user, validate exact origin/window/nonce and lease, and enforce server-owned named operations. Bind payload/version grants at pairing/dispatch; possession of a loader ID is never a credential. Keep DMP cookies/tokens inside the DMP page. Return only the minimum allowed operation result; redact credential-like fields and diagnostics.

**Trust boundary:** admin-authored JavaScript running in a signed-in external page has that page's authority; it is not reliably sandboxed by an origin allowlist or static checks. Treat publishing as privileged code release, restrict it to accountable admins, review diffs/declared purpose and avoid embedding secrets. Keep the loader/protocol validation core outside ordinary editable payload code. The server constrains Temco-mediated dispatch, but cannot promise a malicious published script is unable to call the external page directly. Do not claim otherwise. Never bypass the external site's CSP/COOP or browser policies.

Preserve per-user DMP pairing/session lease, external subject checks, origin constraints, named operation control, request IDs, bounded concurrent execution and no replay. A payload cannot change server operation authorization. Diagnostics should name payload/version, target origin, Temco connection, compatible operation, request ID and failure stage (load blocked, popup, pairing, expired identity, queue, request, parse), without cookies/tokens or raw customer responses.

On mobile, provide a full-width plain source editor with search, undo, save/diff, version selector, synthetic preview, publish summary and rollback. Offer source file import/export for longer edits, with the same authorization. Provide **Copy bookmarklet**, selectable text and phone instructions to create/edit a browser bookmark; dragging to a bookmarks bar cannot be required. Provide **Open target page** and a test checklist. Opening a loader URL alone does not execute it in a different signed-in tab. Verify the actual Zebra browser's bookmark/`javascript:` behavior; if unavailable, use an explicitly approved managed-browser deployment route or supported snippet invocation, without a CSP bypass. Test devices do not automatically gain live mutation authority.

## Identity, capabilities and MCP

### Mobile identity and shared scanners

Keep application-owned users and PostgreSQL. Propose username + strong password/passphrase as the universally available baseline, with passkeys where the actual browser/device supports an appropriate individual authenticator. Do not require a new identity platform. Require a second factor or suitable strong authenticator and recent reauthentication for privileged account, permission and payload publication actions; support recovery before enforcing it. Follow [OWASP authentication guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html): propose a 15-character minimum, support at least 64 characters including spaces/Unicode, block common/compromised passwords, allow password managers/paste, and avoid arbitrary composition/periodic-reset rules. Select a maintained password hash implementation that supports this without silent truncation; benchmark cost parameters during implementation. Existing bcrypt PIN hashes are transitional legacy credentials, not strong enrolled passwords.

Use revocable server sessions referenced by secure HttpOnly cookies; iron-session can remain an envelope, but role/isActive in it is no longer authority. Every protected request resolves the current user, active status, session expiry/revocation and capabilities. Protect cookie-authenticated mutations with exact-origin/CSRF checks, retaining the DMP control route's existing origin check; use session rotation on authentication and bounded idle/absolute expiry. Recheck at command commit and before external dispatch; reject queued actions after revocation. Account disable, role removal, credential reset and explicit revoke affect existing UI, MCP and relay sessions. An action already dispatched may remain uncertain and is not retried.

Invite/enroll users with one-use expiring tokens and verified recovery destinations; no open self-registration. Password reset/verification tokens are random, stored hashed, purpose-bound, short-lived and single-use; use neutral responses, bounded attempts and revoke sessions after reset. Verify changed email before treating it as a recovery address. Provide auditable admin-assisted identity recovery for staff without individual mail, without exposing/resetting a shared public PIN. Never let an admin read a password or recovery token. Rate-limit login/reset/enrollment by account and source/device, with escalating delays and visible administrative recovery; audit sensitive successes/failures without credentials.

For a shared scanner, show the active person prominently, provide lock/switch-user and preserve scanner/printer preferences separately from the person. Start with normal strong sign-in and short idle lock; consider an enrolled-device, user-bound quick unlock after strong sign-in, with bounded validity and attempts. A short code must not work as a public remote credential. A passkey stored on a shared device is not proof of which employee holds it. Switching identities ends the old person's relay/lease and pending authorization, and never transfers queues or attribution. Owners/managers must be able to revoke a lost scanner/session from a phone.

**Email candidate, verified against official docs on 2026-10-31:** [Email Service](https://developers.cloudflare.com/email-service/) includes outbound Sending (beta) through [REST](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/), Workers binding and [authenticated SMTP](https://developers.cloudflare.com/email-service/api/send-emails/smtp/). General-recipient transactional sending requires Workers Paid; [setup](https://developers.cloudflare.com/email-service/get-started/send-emails/) requires Cloudflare DNS and an onboarded sending domain. Email Routing is a separate inbound capability. REST fits the current backend without moving it to Workers. Account plan, selected domain/onboarding, sender authentication, credentials and recovery inbox readiness remain unverified. No email/DNS changes or messages were made. Verify readiness before enabling mail-based recovery; retain an admin-assisted path meanwhile.

### Capability-backed bundles

Replace the single coarse role with many-to-many role bundles backed by explicit capabilities and warehouse/location/device scope. Proposed bundles are operator, floor lead, office-dispatch, operations manager and system admin; Adam must approve actual assignments. Capabilities distinguish view, record observation, allocate/move, sign finals, decide disposition, authorize RTV, execute previously authorized RTV, configure labels, manage users/devices and administer payloads. Viewing a case does not authorize its decision or external action. Payload source administration is system-admin-only even if a manager can edit label ZPL. Multiple bundles grant a union within scope; session/client grants can narrow but never widen it.

Migrate current users conservatively: preserve account IDs and attribution; map roles to reviewed bundles rather than handing every current user new mutation rights. Record changes and revoke stale sessions. UI visibility helps navigation; server checks decide every query/command, export and upload.

### Every user action through the same application layer

Create shared typed application queries/commands under the existing app's `lib/` structure; UI routes and MCP are adapters. Commands accept an authenticated principal/context, validated inputs, explicit object scope, versions and operation/event IDs. Neither adapter accepts an untrusted `userId`/role as authority or accesses Prisma directly around these checks. Use existing domain helpers behind this boundary, consolidating validation/transactions rather than building a second system.

The parity requirement covers **every** action available to a user: dashboard/widget/favorite preferences; search/history/notes; all imports/syncs/exports; scan lists and capture; picks, lane moves and finals/sign-off/amendments; cases/dispositions/authorization; MARS actions/reconciliation; label templates/rules/printers/jobs/reprints; user/access/recovery/session/device administration; payload source/test/publish/rollback/loader generation; file management and diagnostics. If Report Engine remains accessible during transition, its remaining actions also need parity until retirement. Account enrollment/sign-in and authenticator ceremony remain secure user interactions; MCP can initiate and inspect their authorized workflows, not obtain passwords, private keys or bypass a required human gesture.

Use authenticated HTTPS remote MCP with the current [MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization): OAuth authorization-code/PKCE, resource/audience-bound tokens, discovery and explicit user grants. Propose a maintained authorization implementation attached to the existing identity store, not hand-built OAuth or a mandatory new hosted IdP. Recheck supported SDK/protocol versions when implementing. Validate issuer/audience/expiry and current user/session/grant on every call; no token passthrough to DMP, database credentials or blanket admin service identity. Record user, client, granted scopes and selected device/connection with each action. Scope = current user permission intersected with client grant and object/device scope. The existing direct-DB stdio path must be replaced or restricted to an explicit per-user adapter before v2 access; it is not a privilege escape hatch.

MCP may initiate authorized external actions under exactly the same preconditions as UI, including any exact prior office authorization. Return operation IDs and queryable receipts; retries return the original operation state, with mismatched reuse rejected. Receipt reads, status and retries require current user/client/object authorization; possession of an operation ID grants nothing. Unknown MARS/print outcomes require reconciliation, not a new dispatch. Agent/client requests do not manufacture office approval or physical evidence.

Expose authorized connected devices with supported capabilities and availability. A remote client can request a capture/OCR session on a selected scanner/phone, receive its evidence or submit a clearly attributed manual observation. A server cannot claim to have used that phone's camera. Printing targets an authorized managed printer through a selected connected local device/laptop relay; no connected route yields `device unavailable`, not an arbitrary server fetch to a private LAN URL. Preserve useful direct printing from the browser, but record its dispatch through the same command/job boundary before device execution. Device confirmations carry provenance and do not falsely attest a physical result.

## Keep, merge and retire decisions

These are future cutover decisions; no tool is removed by this planning change.

| Current tool/process | Decision | Destination and preservation condition |
| --- | --- | --- |
| Home, favorites, mobile drawer | Keep and extend | Operational dashboard and authorized widgets; retain access to working tools and personal shortcuts. |
| DMP API Relay | Keep and extend | Per-user connection/status and shared expectation sync; preserve current loader alias and named operations. |
| Inventory Audit | Keep as foundation, merge views | Shared WMS inventory/history plus independent observations; preserve full rows, revisions, archive and exports. |
| LPN Put Away | Merge data source, keep task | Saved Placing/received-date view from one import; retain familiar filters and export. |
| Pick Waves | Keep mechanics, extend demand | DMP/WMS allocated work, globally identified scans; retain workbook fallback, staging, labels/history/exports. |
| Route Recon | Merge into dispatch/finals workspace | Retain readable route reports/barcodes and archived runs; add lane verification using official DMP demand. |
| MARS Tracking/import | Keep source/history, merge unit detail | Preserve submissions/events/labels and raw statuses; add physical-unit links without order-only merges. |
| MARS Audit/reconciliation | Replace standalone emphasis with focused worklist | Shared observations + expected returns and trail gaps; preserve existing audits/reports and scoped audit sessions. |
| MARS Label Tool | Keep and integrate | Identified-unit submission labels; migrate helper to payload manager when equivalent mobile behavior is proven. |
| Label Configuration / relay modes | Keep and extend | Versioned purposes/rules/issuance, same printers and direct/laptop routes. |
| Scan Lists | Keep lightweight capture/export | Reuse for ad hoc work; explicit choice before treating an ad hoc scan as a warehouse observation. Preserve drafts and duplicate evidence. |
| Barcode Generator | Keep utility | Reuse for unit/lane identifiers and batch output with managed labels/printing parity. |
| Report Engine | Retire after useful replacements | Saved warehouse views/exports replace operational needs; preserve any stored pipelines/files until reviewed. No generic pipeline rewrite. |
| User Management | Keep and strengthen | Mobile identity, multiple capability bundles, recovery and session/device revocation. |
| Admin File Manager | Keep restricted utility | Explicit uploads/exports, scoped retention and MCP parity; not the authoritative warehouse database or a source of public payload samples. |
| Scanner Diagnostic | Keep | Mobile/device capture diagnostics with safe synthetic data and individual attribution. |
| Existing read-only MCP | Replace transport/auth boundary, reuse domain queries | Full UI/MCP parity with current permissions; retire direct database authority. |

Implementation is complete only when the [finite acceptance scenarios](implementation-plan.md#acceptance-scenarios) demonstrate these connected workflows on the intended devices and the legacy transition has preserved evidence. Planning completion does not qualify live upstream mutations, printing hardware, deployment or human acceptance.
