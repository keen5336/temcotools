# TemcoTools v2 build status

Standing mandate (2026-10-31): implement, test, review, correct, commit and push the agreed v2 build continuously until complete or no useful work remains without a genuine owner-dependent input. This supersedes the initial documents-only boundary and the plan's requirement for a separate implementation assignment. Keep advancing independent work when a source/device feature is pending.

Work only on `v2` in the isolated MacDev worktree. Preserve `main`, `v1` at `fea1f22af1b2fae788388f2aefed3e3998e98d09`, existing local work and production operation. This mandate does not authorize production deployment, paid provisioning, actual mail/DNS changes or live operational mutations. Existing relevant read-only inspection is authorized; never publish secrets/customer data. Inherit GPT-6.1 Sol / `reasoningEffort=xhigh` for helpers and keep integration in the main thread.

## Current checkpoint

- Published baseline: `0e7958487e7ddeb22542c9729c64d9f1751b15a6` (planning documents; no runtime validation claimed).
- Latest tested runtime checkpoint: `e9145c76acbd0ee17350166bed25cbdeaf14a578` (slice 1; subsequent working changes are listed below). `main`/`v1` remote hashes and original checkout remain preserved.
- Mounted external worktree/storage routing verified; independent locked dependencies installed. Original checkout/dependencies are preserved. Disposable PostgreSQL: task-owned container `temcotools-v2-build-db`, loopback port 55439, database `temcotools_v2_test`, data under external Qualification storage. No production database connection was used.
- Active native helpers: `/root/access_foundation` (strong identity, server sessions and capability bundles), `/root/inventory_lookup` (shared WMS, units/aliases and observations), `/root/payload_manager` (mobile admin payload manager). They inherit parent model/settings. Main owns MCP/queue/scan integration, validation, commits and this status.

## Completion matrix

| Area | State | Next concrete result |
| --- | --- | --- |
| 1. Current access + global lookup | Implemented; source/local synthetic validation passed | DB-backed current user/generation, 12h expiry, exact-origin mutation guard, global LPN/order candidates, phone UI and user-bound scoped stdio MCP. PIN replacement and per-session revocation follow in slice 2. |
| 2. Strong identity / capabilities / remote MCP | Implementing | Revocable server sessions, strong credentials/recovery, bundles and authenticated remote transport. |
| 3. Shared WMS / units / observations | Implementing | Retained source revisions, shared Put Away, durable attributed scan ingestion. |
| 4. Admin payload manager | Implementing | Mobile source drafts, immutable versions, publish/rollback, stable loader IDs. |
| 5. DMP history and picks | Source-independent boundaries can proceed | Preserve working relay; qualify actual unit/attempt/line mapping before automatic normalization. |
| 6. Finals | Domain/UI implementation can proceed | Versioned demand/lane confirmations; official source equivalence pending evidence. |
| 7. Cases / expected returns | Planned | Durable dispositions/watch triggers and separate A/B obligations. |
| 8. Labels / devices / effect receipts | Planned | Versioned rules/content/jobs and no replay of uncertain effects. |
| 9. MARS workflow / migration / cutover | Planned | Human-assisted submission linking until upstream creation is evidenced; additive migration/recovery package. |

No source-independent feature is blocked at this checkpoint. Exact upstream mappings, official-finals semantics, real Zebra/printer behavior, recovery provider readiness and live-effect authority remain qualification dependencies; they are not claimed implemented or accepted. See [open questions](open-questions.md).

## Validation and next action

Slice 1: Prisma generation and all 14 migrations passed on a dedicated empty PostgreSQL database. TypeScript, changed-file ESLint and optimized Next build passed. 57 focused authorization/query/favorites/DMP/printer-relay tests passed. Two real-database/SDK/HTTP integration scenarios passed: UI/MCP query equality, scoped grants, role-generation revocation, legacy-cookie rejection, exact-origin enforcement and relay entrypoint rejection after revocation. No actual Zebra/operator, physical printer, live upstream, mail or deployment qualification is claimed. Initial dependency audit reports existing high/critical advisories; triage/update remains required before release.

Next concrete packages are running concurrently: strong identity/server sessions, shared WMS/unit/observation data, and admin payload management. Main next integrates durable attributed observation capture/Pick Wave and MCP command parity. Do not stop on this checkpoint.

## Continuation policy

Owner steering, 2026-10-31: keep several substantive dependency-ready packages mapped ahead. Integrate/review/correct/commit completed stages and immediately advance within the active turn. The hourly Work supervisor is recovery/review fallback, not an assignment gate. Helpers finish their bounded task; the main thread owns continued progress. Do not expand scope merely to stay busy.

The current T3 queue was inspected: exactly one owner-added adaptive continuation is queued, ordinal 3, with run reference `run:thread:mcp%3Alaunch%3Aa32fe0cbc29f1c50ea0a11854668f16084313b25564b2fee4a6e5934401e09e7:ordinal:3`; no duplicate was created. The active and queued runs report `gpt-6.1-sol`; inherited runtime effort remains Extra High. At a genuine technical/context boundary, checkpoint current HEAD, validation, working changes/helper references and next action, then verify at most one adaptive continuation before ending. Each continuation rereads state/owner steering. Cancel an unused continuation when complete or all useful work is owner-blocked; no no-op loops or idle retries. A queue receipt verifies queued delivery, not a guarantee against later cancellation/runtime failure.
