# Parallel pilot launch and owner handoff

**UI:** https://temco-v2.chronchive.com/ · **MCP:** https://temco-v2.chronchive.com/mcp. **Live image/source: `94782b71356a8859cbd75bb7c1461c5527c7729c`**, native Linux/amd64,40 migrations. Later documentation commits do not change these images. Adam's existing password login is preserved; owner-client attachment and privileged MFA remain human steps.

## Approved target and isolation

Adam explicitly approved the new hostname and isolated launch. Only the new proxied A `temco-v2.chronchive.com`→`15.204.239.71` was created Nov1, record `eff39ea73f2fda45b9504b2bd3d15d0c`; no production DNS changed. No new DNS/security/TLS edit was needed for the current release.

Existing strict SSH: `ssh -F /Users/openclaw/.ssh/config.codex-isolation-saved-20260814-204227 -o BatchMode=yes -o StrictHostKeyChecking=yes vps`, actual `ubuntu@15.204.239.71`. Source `/srv/temcotools-v2-pilot/source` is clean `v2` at the runtime pin. Project `temcotools-v2-pilot-parallel` uses DB `temcotools_v2_pilot_parallel`, private DB/admin-files volumes and network, dedicated keys/cookie `temco_v2_pilot_parallel`, DMP audience `pilot:parallel` and separate generic audience. Private env `/srv/temcotools-v2-pilot/private/pilot.env` remains0600; no values are exported.

Only app43100, browser relay43103 and MCP43104 publish to loopback. DB5432 is unpublished. The pilot Caddy fragment exposes UI/human consent, MCP/OAuth/discovery and exact `/api/api-relay/ws` plus `/api/integration-relay/ws`. Private `/control` and `/api/internal/*` are404; label socket403; no production fallback. Parent Caddyfile SHA256 remains `0f15706104853b5cc0f4707c7d3b694f25605ee930a471238760d5e930a154f4`, pilot fragment `585fde6508e66eaa75db7e7a98534635304806f5821d2db9f0b6f412f4544b9d`. Both files are unchanged by these releases. No WAF/BIC/Host/TLS weakening or UA substitution occurred.

`TEMCO_PILOT_MODE=read_only_dmp` remains active: external WMS receipt/close and live printing/MARS execution unavailable, DMP GET/HEAD only, configured generic semantic READs separately authorized. Custody planning/history are available; physical departure/check-in commands deny. No label relay runs, no upstream payload/mapping/action is silently published, and no browser session is copied. POST query semantics require an evidenced approved READ contract; no RP endpoint/identity/status meaning is invented.

## Exact current native resources

| Role | Container prefix | Native image ID |
| --- | --- | --- |
| App | `dd0b6faae2e2` | `sha256:dfd50056806fd82187afc68d597ed1363c74b7725eb42425636f51a02875f6d0` |
| DMP/generic API relay | `e3f37c0e5023` | `sha256:fd7a8a5e6b00c36cfabb65a8977913c9ef054d82117dbfb2e85fd439045dfe34` |
| MCP HTTP | `3d8d9b6d847f` | Same full MCP image above |
| Migrator candidate,947 schema unchanged | Not invoked | `sha256:c43cf8d9ddcc50d97fba5ea364537ae870bf718bcac97ba8e9612b15a865571a` |
| Original pilot PostgreSQL15.15 | `b872082621ef` | `sha256:bb506a9728d218a29ad9c1fd7ed6acb713214fa3fe10dbc875c5cd1a865ebb46` |

Program tags are `temcotools-v2-pilot-parallel-{app,mcp,migrate}:94782b71356a8859cbd75bb7c1461c5527c7729c`. App/MCP started23:13:04UTC Nov3, API23:13:20UTC. API uses the full MCP image and `node --import tsx scripts/api-relay/runtime.ts`; legacy production entry remains unchanged. DB retains its Nov1 start. Program runtime is Node24.22.2/UID1001.

Migrations39/40 were actually applied with the pinnedf92 migrator `sha256:8a6f1c3848f36a44f72e90324db3fe498ce87c9d6251efe0a6f37bb3894d1d14`, after stopping only pilot app/API/MCP. New-image preflight passed before admission.947 adds only the MARS gate-before-row correction; its schema is identical and its migrator was not rerun.40 complete/no pending/failed/checksum mismatch;81 forced operational tables, restricted runtime, bounded function owners and no migrate-phase blockers. Privileged owner MFA/recovery is an explicit warning, not evidence of completed enrollment.

Current private native artifacts: `/srv/temcotools-v2-pilot/artifacts/94782b7/`; guard `/srv/temcotools-v2-pilot/receipts/render-94782b7/`;40 migration/pre-admission logs `/srv/temcotools-v2-pilot/artifacts/f92f9ec/`. MacDev package `Qualification/temcotools-v2-custody-94782b7-20261103/` retains pinned build/deploy scripts, asset proof and scoped SDK summary. No secret/enrollment payload belongs in Git/chat.

## Actual qualification and preservation

- Native build `20261103-171240-build-20675`, source/image/resource guard+rollout `171324-build-21022`; all selected services running, app signin200/broker health200/MCP unauthenticated401. Native947 preflight independently confirms40/81. Production app/label/API/DB IDs/images/start times/mounts/ports and sign-in200, original pilot DB, protected env values and proxy bytes are preserved. Main/v1 remainfea1f22. Adam's private identity/factor/recovery/session/grant fingerprint matches; no reset/impersonation.
- **Actual public scoped SDK on947 PASS** `171426-build-21220`: native Linux/x64/UID1001, real synthetic password/TOTP/PKCE and read-only consent before MFA; current scope/session revocation and pilot-effect denial; normal public HTTPS headers/default TLS, revoked bearer401. Temporary synthetic actor/client removed; other actors preserved/effect rows0. This is not Adam's MCP attachment.
- **Actual public Chrome onf92 PASS5/5** `170930-build-20120`:390px/Auckland, synthetic password sign-in, anonymous/site-admin Lab denial, warehouse/RSC isolation, real custody/provider/template pages, BOTH real workers on the same synthetic frame. External OCR0, errors0, overflow0; temporary people/sessions/sites0 after cleanup, Adam unused.947 changes only MARS lock order; browser/scanner source is identical. All26 actual947 asset hashes match (117,792,876 bytes). Physical Zebra/Android/iPhone/camera/printing acceptance is pending; no hardware benchmark is claimed.
- Current source tests and actual108-table40 restore/ownership/ACL/RLS/key/no-replay results are summarized in [build status](build-status.md) and [cutover package](cutover-runbook.md#latest-qualification-40-migrations). Restore config/operation ledgers were empty; separate broker/unknown-receipt tests qualify those paths.

## Usable owner paths

[TemcoScan Lab](https://temco-v2.chronchive.com/tools/scan-lab) · [Workflows / Receiving practice](https://temco-v2.chronchive.com/tools/workflows) · [Custody / identity gaps](https://temco-v2.chronchive.com/tools/custody) · [Warehouse settings](https://temco-v2.chronchive.com/management/warehouse) · [Connections/actions](https://temco-v2.chronchive.com/management/connections) · [Templates/defaults](https://temco-v2.chronchive.com/management/templates) · [Payloads](https://temco-v2.chronchive.com/admin/payloads) · [Account security](https://temco-v2.chronchive.com/account/security) · [MCP setup](https://temco-v2.chronchive.com/account/access).

Sign in using the existing `adam` account. All original enrollment material is consumed; no new code/password/factor was issued. Complete privileged MFA/recovery privately in Account security before publishing payloads/action definitions or approving privileged scopes. No agent chooses or reads the human's authenticator.

For the first two-read MCP connection, run on the Mac while ready to approve immediately:

```sh
codex mcp login temcotools_v2 --scopes workflow.read,inventory.read
```

The fresh browser page returns to the CLI's current127.0.0.1 listener on that same Mac. Old timed-out pages cannot complete it. Read-only consent needs no privileged MFA proof. Check CLI success and one actual authorized MCP read before declaring the assistant connected; configuration/synthetic SDK success is separate. Add other scopes only through later explicit human consent. No agent approves this request.

For injection, use the [provider connection guide](provider-connection-guide.md): deliberately draft/publish the appropriate built-in payload, exact site profile and qualified named action/warehouse/identity contract; install the one Connect TemcoTools bookmark. The work browser keeps its own upstream sign-in, then its human activates/pairs the exact tab and grants named reads to the intended session/client. The server/MCP receives no cookies. Empty/unpublished/unsupported mappings do no operational work. DMP remains separate from RP/MARS; private body-only JSON/XML/CSV intake can proceed without pretending it qualifies a live adapter. Official finals/device acceptance remain pending.

## Recovery and continuation

Preserve DB/files/keys/audit/unknown-effect ledgers. Suspend only the exact pilot project if necessary; use forward repair or a verified separate restored database. An8e/v1 binary is not a safe rollback over the new40 schema/auth/history. Never `down -v`, prune, reset Adam, replace production resources or replay an uncertain external effect. Root-private original proxy/TLS backup remains `/root/temcotools-v2-pilot-backup-20261101/caddy-before.tar`; it is unrelated to this schema rollout.

The source-independent expanded release and retained-workflow review are complete. [Build status](build-status.md) records the exact remaining upstream/human/device inputs; all helpers finished and the unused adaptive continuation was cancelled, with empty queue readback. Existing Work supervision is active recovery/review only, without guaranteed instant execution. No additional coordinator/schedule/continuation was created. [Prior launch records](https://github.com/keen5336/temcotools/blob/f92f9ec491c7a5ae06653fbf326568748b7b6e16/docs/v2/pilot-launch-status.md) preserve historical5187/48c/2ae/d261/8e pins and failed probes; they are not current images.
