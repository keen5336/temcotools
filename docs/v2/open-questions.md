# TemcoTools v2: bounded open questions

These questions gate particular capabilities, not the entire plan. The [strategy](strategy.md) fixes the operational model; the [implementation plan](implementation-plan.md) can begin with source-independent access and lookup work. No customer samples, credentials or captured production payloads belong in this public repository.

Late-night owner steering: Adam is home without DMP access. Q1/Q2 reference requests are parked until work access is convenient; do not ask for credentials/screens tonight. Authenticated MCP is now running locally as described in the [handoff](mcp-runbook.md#running-isolated-local-preview). Independent implementation/qualification continues. Baseline source statements below are explicitly historical where v2 has since implemented the planned boundary; [build status](build-status.md) is the implementation record.

## Q1. Obtainable unit, line, attempt and submission links

**Verified in source:** [DMP config](../../lib/api-relay/config.ts) defines `session` and `deliveries`, including the existing deliveries-by-date/location request. The owner confirms that integration works well. Other operations can be configured, but their deployed configuration was not inspected. No checked-in DMP response contract establishes MSN/line quantity, attempt outcomes, exchange direction or submission linkage. [`PickWaveItem.trackingNumber`](../../prisma/schema.prisma) is not evidence that this is MSN. [MARS workbook import](../../lib/mars/import.ts) has request/order/serial/model/status/replacement fields, but no typed MSN or LPN link. The [label helper](../../app/tools/rtv-label/MarsLabelClient.tsx) extracts from a detail page; it does not create submissions.

**Owner requirement/fact:** DMP and MARS have order–MSN–submission relationships. Any linked identifier should reach the same physical unit, while A/B replacements remain separate.

**Needed evidence:** using available authorized read-only evidence, inspect only the named read operations and representative field relationships for normal delivery, multiple appliance lines/quantities, missed attempt, successful exchange, reschedule, and changed/resubmitted MARS return. Record field names/types, cardinalities, stable external IDs, source timestamps, pagination/completeness and status meaning. Distinguish historical versus current rows and explicit exchange completion versus mere scheduling. Keep raw evidence private; commit synthetic structural examples with no actual customer/order/serial values. Do not assume a return is cancelled because it is absent from one response.

**Resolution owner:** implementer with Adam/office review of meanings. **Gate:** slice 5 cross-system automation and slice 9 automated MARS. **Progress now:** LPN-based inventory/query/observations, unresolved identifier review and payload management. No speculative endpoint or invented payload schema is required.

## Q2. Official finals source and lane mapping

**Verified:** existing [Route Recon](../../lib/route-recons.ts) parses uploaded pick workbooks. No source adapter implements Ashe's official DMP finals calculation.

**Owner requirement:** finals must use the same DMP data/rules Ashe uses for printed official finals, for a selected dispatch day; WMS's interpretation is inaccurate.

**Needed evidence:** Ashe's actual official-finals source/action and the selected-day/warehouse/route filters; finalization/change semantics; exact item/line/quantity representation (including cancels, service/accessory lines and replacements); route-to-physical-lane conventions and no-lane/overflow cases. Compare a private official output against the existing obtainable DMP results. Do not assume that `driversDeliveries` alone is sufficient. Ask only for decisions the evidence cannot settle, such as who may sign off an unresolved exception.

**Resolution owner:** Adam/Ashe and implementer. **Gate:** slice 6 official finals and sign-off. **Progress now:** shared identity, pick mechanics, lane observation model and version/amendment design. Printed Route Recon remains available without being relabeled official finals.

## Q3. Handling authority and supported MARS creation

**Verified:** source supports MARS imports/audits/label extraction; no confirmed external submission-creation contract is present. Current roles do not encode separate decide/authorize/execute permissions.

**Owner requirement:** a scanned unit can initiate the appropriate MARS submission and label within operator rights or prior office authorization, with duplicate protection and unknown-outcome handling. Missed delivery does not always mean RTV.

**Needed decisions/evidence:** approved capability assignments and who can authorize/execute RTV or conditional instructions; required return reasons/vendor prerequisites; supported creation workflow/API and any CSRF requirements; duplicate/existing-submission lookup; observable result/submission ID and reconciliation path after a lost response. Confirm whether a void/resubmission changes the link to the physical unit. Obtain explicit authority for any live mutation trial.

**Proposal until resolved:** identify the unit, show eligibility and prior authorization, open the supported MARS human workflow, then associate its resulting submission and print through the existing tool. Do not fabricate automated creation. **Gate:** automated slice 9 action only; cases, expected-return worklists and existing labels can proceed.

## Q4. Zebra, browser and printer capabilities

**Verified:** [ScannerCapture](../../components/scanner/ScannerCapture.tsx) handles keyboard-wedge scans; [printing](../../lib/label-printing.ts) supports direct and laptop relay browser sends. Neither establishes camera/OCR support, DataWedge configuration, managed bookmark installation or physical print acknowledgement on a particular device.

**Needed evidence:** actual Zebra model/Android/browser versions and scanner output profile; supported bookmark/`javascript:` invocation on that browser; camera permission/OCR feasibility; shared-device identity/lock workflow; printer model/media/DPI, LAN reachability and laptop relay availability. Test source editing, diff/publish and loader installation on phone width and real devices. A plain **Open loader** link cannot inject into another site's signed-in page. Do not bypass CSP or browser/network policy.

**Proposal until resolved:** wedge/manual capture and existing managed printer/relay modes are baseline; camera/OCR and special managed-browser installation are optional adapters. Keep physical print confirmation separate from a successful send. **Gate:** device-specific promises in slices 3/4/8 and final mobile acceptance, not the source plan or first lookup slice.

## Q5. Recovery readiness and authentication deployment

**Verified publicly on 2026-10-31:** Cloudflare [Email Service](https://developers.cloudflare.com/email-service/) includes outbound Sending beta via REST/Workers/SMTP. General-recipient transactional sending requires Workers Paid; [domain setup](https://developers.cloudflare.com/email-service/get-started/send-emails/) requires Cloudflare DNS and an onboarded sending domain. Email Routing alone is not general outbound sending. The planning baseline had PIN auth/no recovery; v2 now implements strong passwords, server sessions, MFA and auditable one-use admin-assisted enrollment/recovery. Email delivery is still unconfigured.

**Unverified:** intended recovery sender domain/account plan, domain onboarding/authentication, API permission and secure credential delivery, recipient inbox readiness, and whether all staff have individually controlled recovery destinations. No account credentials, DNS state or mail service configuration was inspected in this turn.

**Needed decision/check:** choose verified individual email recovery versus auditable admin-assisted recovery for each staff population, establish initial admin recovery and select a maintenance window for credential/session migration. Inspect relevant account/domain readiness read-only under the standing read-only inspection authority before claiming email is configured; mail/DNS changes and test sends require explicit authority. Confirm passkey/second-factor fit on shared scanners before making it mandatory.

**Proposal:** keep app-owned accounts, strong password/passphrase baseline, revocable sessions, privileged strong authentication and admin-assisted recovery. REST is a viable Cloudflare sending adapter without changing hosting; use a development mail sink first. **Gate:** enabling actual mail-based recovery and public v2 identity cutover. Current-session checks and local enrollment/recovery development can proceed.

## Choices already made for planning

Use the existing application/database/relays; separate source, expectation, observation, disposition and label state; keep original/replacement units distinct; globally identify before task matching; preserve unknown outcomes without replay; deliver UI/MCP parity through one application layer; retain mobile administration; and migrate additively. Exact role bundle names, table names and UI wording are proposals that can be refined in implementation. Receiving cutoff, a new identity platform and broader platform infrastructure are not open prerequisites.
