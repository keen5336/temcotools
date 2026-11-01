# Parallel pilot launch and first-account handoff

**Live isolated pilot:** https://temco-v2.chronchive.com/ · **MCP:** https://temco-v2.chronchive.com/mcp. Application/image source is `5187dc08422aad71b6fc0962364a24704c0d1b2f`; later documentation commits do not change that runtime. Native VPS, public HTTPS SDK and independent Chrome sign-in/discovery checks passed on 2026-11-01. Adam's own activation and client consent remain human steps; full v2/upstream/device acceptance is not complete.

## Authority and actual routing

Adam answered **“Yes I approve”** to the exact new-host DNS and isolated-pilot launch question. This cleared the earlier automatic approval rejection. The coordinating root created only the new proxied A `temco-v2.chronchive.com` → `15.204.239.71` at 17:27:41 UTC on 2026-11-01, record `eff39ea73f2fda45b9504b2bd3d15d0c`. DNS has one writer; do not duplicate it. Production `temco.chronchive.com`, main/v1, paid services, mail and real operational effects are outside this pilot change.

Strict known-host SSH uses the existing saved configuration: `ssh -F /Users/openclaw/.ssh/config.codex-isolation-saved-20260814-204227 -o BatchMode=yes -o StrictHostKeyChecking=yes vps`. Its actual target is `ubuntu@15.204.239.71`. No production secrets/browser sessions were copied.

The exact new Caddy vhost now routes UI/human consent to loopback43100, MCP/OAuth/discovery to43104 and only `/api/api-relay/ws` to43103, preserving the public Host. Private `/control`, `/api/internal/*` and relay-control aliases return404; the label socket returns403. There is no production fallback. Origin HTTPS and independent real Chrome verified valid TLS, sign-in and discovery. Python urllib's Cloudflare1010 was retained as a client-specific failed probe; actual public native fetch/SDK passed with its normal headers and certificate validation. No WAF/BIC/TLS weakening or browser-UA substitution was used.

Root-private proxy/TLS backup: `/root/temcotools-v2-pilot-backup-20261101/caddy-before.tar`, with original configuration, maintenance fragment and validation/reload logs. Parent Caddyfile SHA256 remains `0f15706104853b5cc0f4707c7d3b694f25605ee930a471238760d5e930a154f4`: original bytes plus only the new explicit import. Admitted `/etc/caddy/sites/temco-v2.caddy` SHA256 is `5d82512a4a074c1fe4ce04770b6beedd775113d87e40a91009b9d00893cad8a1`, matching the staged reviewed fragment. Full configuration validation and graceful reload passed; no established production3002/3003 upstream streams were present immediately before it.

## Native target and isolation

Host is Linux/x86_64, Docker29.1.3, Compose2.29.2, Caddy2.11.2. Separate clean deployment source `/srv/temcotools-v2-pilot/source` is pinned to5187. Project `temcotools-v2-pilot-parallel` owns only database `temcotools_v2_pilot_parallel`, volumes `temcotools-v2-pilot-parallel-db` / `temcotools-v2-pilot-parallel-admin-files` and bridge `temcotools-v2-pilot-parallel-private`. Private root 0700/env 0600 contain newly generated DB/session/MFA keys; no production environment is selected. An off-host private copy of these new pilot keys is retained under the MacDev launch artifact directory.

Cookie is `temco_v2_pilot_parallel`, relay audience `pilot:parallel`, exact public origin as above. `TEMCO_PILOT_MODE=read_only_dmp` remains enabled: live printing/MARS execution and Office RTV authorization are masked, non-GET/HEAD DMP requests are denied, and no label-relay service runs. No source sample, payload publication or site mapping was automatically seeded. Route Planner remains review-only with no guessed identity or live POST.

| Service | Container prefix | Native image configuration ID | Binding |
| --- | --- | --- | --- |
| app | `c3ea67dbcebf` | `sha256:52d2654c9a9cf80aea93050f5d5d4ce755df43bf0ea22f52697d6f16d09a8f1f` | `127.0.0.1:43100` |
| API relay | `c6349679403e` | Same source-pinned app image above | `127.0.0.1:43103` |
| MCP | `debac4b5e54a` | `sha256:420095592ef3e05175dd7b2279b51a092e0f28064d7655b93ec2bb4b07082e18` | `127.0.0.1:43104` |
| Migrator, completed | One-off | `sha256:b7d39c64691355f9e9910c050b9d9a5d69b006a9d811d9eb156f6591de25552a` | None |
| PostgreSQL15.15 | `b872082621ef` | `sha256:bb506a9728d218a29ad9c1fd7ed6acb713214fa3fe10dbc875c5cd1a865ebb46` | Unpublished5432 |

Program tags are `temcotools-v2-pilot-parallel-{app,mcp,migrate}:5187dc08422aad71b6fc0962364a24704c0d1b2f`; these native classic-Docker configuration IDs differ from local containerd index IDs. PostgreSQL uses immutable upstream digest `sha256:1d1095b0503145be79c79239372aefadfacf6b7c33c9245bbf99ce4b6b89c737`, without replacing the production tag. Actual program runtime is Node24.22.2/Linux/x64, UID/GID1001; shared private files are 0700/0600. App/MCP/relay started 17:31–17:32 UTC; all 31 migrations applied to the fresh pilot database.

The three-image archive was transferred and SHA256-verified before load: `926393c4e162f3f1e3155a19d3abce9be5b73d0a2aaac110cfbce9b0dceb6f24`. Native guard render, loaded-image verify and immediate prestart verify passed with sourceState/clean-branch checks retained. The task-private official Node24.22.2 binary runs the same source-pinned guard; no system Node installation or alternate enforcement was introduced.

Production `/srv/temcotools` remains clean published main/fea1f22. App/label/API/DB IDs `00d4d1e637cd`, `410f55a04bd9`, `f8299cd43494`, `a8b7323556b4`, their start times, images and mounts matched the private before/after baseline. Production origin sign-in and both relay health endpoints stayed200. No production container restart, DB/volume/file/key mutation or image retag occurred.

## Qualification and honest limits

- Native startup: loopback sign-in200, discovery200, unauthenticated MCP401, relay health200, unpublished DB and dedicated storage. Native migration readiness passed. Receipts are `/srv/temcotools-v2-pilot/receipts/{native-loaded-images,native-startup}.json`, `render-final/manifest.json` and retained private guard/migration logs.
- Reused scoped fixture `20261101-114236-build-64782.json` passed actual native password/TOTP/PKCE, shared SDK lookup/catalog, scope/admin denial, current-session revocation and pilot effect denials. It also passed **actual public HTTPS** metadata/UI200, scoped SDK action/admin denial and revoked bearer401 using normal native client headers. Synthetic actor/client were removed; baseline counts preserved and effect rows zero. No owner identity was impersonated. Summary: MacDev `Qualification/temcotools-v2-native-pilot-5187dc0-20261101/combined/native-internal-summary.json`.
- Native TLS WebSocket isolation accepted the configured DMP origin101 and immediately closed the unauthenticated fixture; RP/MARS origins were403. This tests transport isolation, not authenticated upstream identity, actual pairing, CSP or a live named read. Receipt: `receipts/native-origin-ws-isolation.json`.
- Independent Chrome verified the public password sign-in/pilot banner and authorization-server discovery with no TLS warning/challenge. Actual owner MCP-client attachment/consent is still pending.
- Earlier3f98994 HTTPS390px phone qualification, local5187 arm64 rehearsal and emulated-amd64 qualification remain separate receipts in [build status](build-status.md). They are not relabeled as native VPS/public-browser or real Zebra qualification.

## Named private owner handoff

Username **adam** / display name Adam was created through the existing guarded native bootstrap. The original enrollment expired at 18:15 UTC; the owner subsequently reported the expected invalid/expired error and no password had been saved. At 21:28 UTC, the existing guarded `--enroll-existing` CLI issued a fresh private code, preserved the account ID and invalidated the old code. Readback confirms **unenrolled, MFA disabled, exactly one valid unredeemed enrollment**; no password, factor or owner session was chosen by an agent. The replacement expires **2026-11-01T21:58:36.429Z**. Public account setup: https://temco-v2.chronchive.com/signin/recovery.

The code is only in mode0600 private delivery files, never this repository/chat/tool output. On the workspace Mac, Adam opens `/Volumes/MacDev/ProjectArchive/Development/Qualification/temcotools-v2-pilot-launch-20261101/private/adam-enrollment-20261101T212835Z.txt` privately. The host copy is `/srv/temcotools-v2-pilot/private/adam-enrollment-20261101T212835Z.txt`. Nonsecret expiry/delivery metadata is beside the local file and in host `receipts/owner-enrollment-metadata-20261101T212835Z.json`. Do not read the code for him, redeem it or automatically reissue on expiry; use the existing guarded `v2-bootstrap.ts --enroll-existing` flow if a deliberate reissue becomes necessary.

Adam uses the code to choose his own password, signs in, enrolls MFA and saves recovery codes at `/account/security`, then attaches his MCP client to `https://temco-v2.chronchive.com/mcp` and approves its minimal scopes through the real consent UI. `/account/access` manages grants. The launch preflight correctly remains exit2 until this privileged enrollment/MFA/recovery custody exists; service/transport qualification has passed. The current blockers concern that single pending human administrator, not an extra migration or production-account import.

After activation, rerun the existing preflight against **only** the pilot and retain its private receipt:

```sh
ssh -F /Users/openclaw/.ssh/config.codex-isolation-saved-20260814-204227 \
  -o BatchMode=yes -o StrictHostKeyChecking=yes vps \
  'docker exec debac4b5e54a node --import tsx scripts/v2-preflight.ts --expect-database temcotools_v2_pilot_parallel --allow-operational-target --phase launch'
```

The explicit operational-target flag admits only the exact named pilot database; it does not select production. This reads the pinned container's own environment and prints aggregate readiness, without exporting keys. A later replaced container requires its verified current ID. Then follow the [first collaboration session](pilot-runbook.md#first-collaboration-session-after-approved-launch): pair the work browser, explicitly share a named read to the same person's client, or privately intake a body-only JSON/CSV/XML export. Browser DMP login stays on the work machine; server/MCP do not receive its cookies. Route Planner identity/read/complete-route evidence and Ashe's official finals (likely Tuesday) remain separate pending qualifications. No live upstream call, warehouse mutation, email or print was performed during launch.

## Preserve and recover

New pilot environment/keys, database/files and audit/unknown-effect ledgers stay private and retained. To suspend admission, validate and restore **only** the new hostname's saved maintenance fragment, then gracefully reload after checking relevant streams; production routes remain unchanged. Stop only the explicit pilot Compose project if needed. Never use `down -v`, prune, replace production resources or run an old image against a forward-migrated database. The [pilot runbook](pilot-runbook.md) and [cutover package](cutover-runbook.md) retain the concrete recovery boundaries; production cutover is not authorized.

Existing Work recovery/review supervision is active, without guaranteed instant/continuous execution. The T3 queue was read back empty at this checkpoint; no new coordinator, supervisor or idle continuation was created. The next useful source work is evidence-backed DMP normalization/RP qualification when the owner connects or supplies private bodies; do not manufacture mappings while awaiting that human input.
