# Parallel pilot launch and first-account handoff

**Live isolated pilot:** https://temco-v2.chronchive.com/ · **MCP:** https://temco-v2.chronchive.com/mcp. Application/image source is `48c646fcf43acde8995b028526cb084581f89f4c`; later documentation commits do not change that runtime. Native VPS, public HTTPS SDK and independent Chrome sign-in/discovery checks passed on 2026-11-01. Adam completed password activation; his client consent and privileged MFA remain human steps; full v2/upstream/device acceptance is not complete.

## Authority and actual routing

Adam answered **“Yes I approve”** to the exact new-host DNS and isolated-pilot launch question. This cleared the earlier automatic approval rejection. The coordinating root created only the new proxied A `temco-v2.chronchive.com` → `15.204.239.71` at 17:27:41 UTC on 2026-11-01, record `eff39ea73f2fda45b9504b2bd3d15d0c`. DNS has one writer; do not duplicate it. Production `temco.chronchive.com`, main/v1, paid services, mail and real operational effects are outside this pilot change.

Strict known-host SSH uses the existing saved configuration: `ssh -F /Users/openclaw/.ssh/config.codex-isolation-saved-20260814-204227 -o BatchMode=yes -o StrictHostKeyChecking=yes vps`. Its actual target is `ubuntu@15.204.239.71`. No production secrets/browser sessions were copied.

The exact new Caddy vhost now routes UI/human consent to loopback43100, MCP/OAuth/discovery to43104 and only `/api/api-relay/ws` to43103, preserving the public Host. Private `/control`, `/api/internal/*` and relay-control aliases return404; the label socket returns403. There is no production fallback. Origin HTTPS and independent real Chrome verified valid TLS, sign-in and discovery. Python urllib's Cloudflare1010 was retained as a client-specific failed probe; actual public native fetch/SDK passed with its normal headers and certificate validation. No WAF/BIC/TLS weakening or browser-UA substitution was used.

Root-private proxy/TLS backup: `/root/temcotools-v2-pilot-backup-20261101/caddy-before.tar`, with original configuration, maintenance fragment and validation/reload logs. Parent Caddyfile SHA256 remains `0f15706104853b5cc0f4707c7d3b694f25605ee930a471238760d5e930a154f4`: original bytes plus only the new explicit import. Admitted `/etc/caddy/sites/temco-v2.caddy` SHA256 is `5d82512a4a074c1fe4ce04770b6beedd775113d87e40a91009b9d00893cad8a1`, matching the staged reviewed fragment. Full configuration validation and graceful reload passed; no established production3002/3003 upstream streams were present immediately before it.

## Nov3 expanded release — current native runtime

**Live runtime source `2ae6cb2d39d7d685035c469f2383ef56a67df0d2`**, deployed November3 at20:25 UTC on the same isolated host/project. Documentation/tests may advance beyond this pin. Source `48c` below is the previous release, retained as history, not the current runtime.

| Service | Current container prefix | Native amd64 image ID |
| --- | --- | --- |
| App | `7b006d77e9aa` | `sha256:c0c386486aa766142c65d42728d98a9a1bc825ffd19ae3d6982228f356055c67` |
| Existing DMP API relay | `79a941d3d64d` | Same pinned app image |
| MCP HTTP | `be3d8544ce6d` | `sha256:db009517e1fcf21d4776a0f6d21dce078a4e9d9cd19a176cf8e49337bd1cc8fa` |
| Migrator, completed | One-off | `sha256:7788ac93a6fe1c942bac7b50c9bd7aaefa83065bef1dedc023e63dabbc49ff1a` |

The original DB container `b872082621ef` remains at its November1 start. All34 migrations applied successfully with no pending/failed/checksum/unknown entries. Source/image/clean-v2/resource/port guard render+verify passed. Private receipts/logs: `/srv/temcotools-v2-pilot/artifacts/2ae6cb2/` and `/srv/temcotools-v2-pilot/receipts/render-2ae6cb2/`. The compose migrator consumed remaining stdin in the first launcher, leaving the pilot stopped after a successful migration; actual DB state34/0 was verified, then only the three intended pilot services were started. No schema replay or production restart occurred.

Private before/after fingerprints matched Adam's identity, password/PIN envelope, MFA/factors/recovery, retained session/grant state and all pilot keys/database/origin. No new enrollment/reset/login impersonation was performed. Production container IDs/images/start times/mounts/ports and clean main `fea1f22` matched before/after; production sign-in200. Main/v1 published refs remain `fea1f22`.

Current qualification:

- Full local optimized2ae app and actual390px Chrome integration passed: platform-only Lab denial, cross-tab/RSC warehouse pinning, Receiving run persistence, real same-frame Tesseract+Paddle workers, no external recognition request/overflow. Receipt `20261103-141433-build-82293`.
- Native Linux/x64/UID1001 password/TOTP/PKCE/scoped SDK, read-only consent before MFA, scope denial, current session revocation and pilot-effect denial passed; the reused fixture was adapted to explicit platform/site authority and a privileged **synthetic-only fixture client** for honest before/after counts. Actual public HTTPS SDK passed with normal native headers/default TLS verification; revoked bearer401. Temporary synthetic person/client removed and effect rows0. Receipt `20261103-142708-build-84433`; private summary `Qualification/temcotools-v2-expanded-2ae6cb2-20261103/native/native-internal-summary.json`. This is not Adam's MCP attachment.
- Actual incognito public browser sign-in/discovery200; anonymous Lab redirects to sign-in; public control/internal callbacks404 and label socket403. Worker JS/manifest200 with JavaScript/JSON types; Paddle/Tesseract workers200 and ORT binary200/application-wasm. Inert static assets remain public; the Lab page is platform guarded. Direct private app callback correctly requires authorization401, distinct from the public404 proxy block.
- Native app verifies all26 runtime/model asset hashes,117,792,876 bytes, pinned Paddle0.4.2/ORT1.24.3/Tesseract7.0.0. These assets are lazy on the pilot origin. Real handheld/camera/hardware benchmarks remain pending.
- Owner MFA is still unconfigured: preflight migrate phase has no blockers but warns privileged MFA/recovery custody is pending. Password enrollment, existing owner access and read-only MCP are usable; sensitive publication/authorization asks for current password+MFA. No owner factor was configured by an agent.

Usable test paths: [TemcoScan Lab](https://temco-v2.chronchive.com/tools/scan-lab), [Workflows/Receiving practice](https://temco-v2.chronchive.com/tools/workflows), [Warehouse settings](https://temco-v2.chronchive.com/management/warehouse), [Connections/actions](https://temco-v2.chronchive.com/management/connections), [MCP setup](https://temco-v2.chronchive.com/account/access). The generic provider registry is still configuration/preview only; upcoming transport glue is not part of2ae. Live WMS/MARS/printing remain disabled/uninvoked, and source mappings/official finals/device acceptance remain separate.

## Previous48c native target and isolation



Host is Linux/x86_64, Docker29.1.3, Compose2.29.2, Caddy2.11.2. Separate clean deployment source `/srv/temcotools-v2-pilot/source` is pinned to48c. Project `temcotools-v2-pilot-parallel` owns only database `temcotools_v2_pilot_parallel`, volumes `temcotools-v2-pilot-parallel-db` / `temcotools-v2-pilot-parallel-admin-files` and bridge `temcotools-v2-pilot-parallel-private`. Private root 0700/env 0600 contain newly generated DB/session/MFA keys; no production environment is selected. An off-host private copy of these new pilot keys is retained under the MacDev launch artifact directory.

Cookie is `temco_v2_pilot_parallel`, relay audience `pilot:parallel`, exact public origin as above. `TEMCO_PILOT_MODE=read_only_dmp` remains enabled: live printing/MARS execution and Office RTV authorization are masked, non-GET/HEAD DMP requests are denied, and no label-relay service runs. No source sample, payload publication or site mapping was automatically seeded. Route Planner remains review-only with no guessed identity or live POST.

| Service | Container prefix | Native image configuration ID | Binding |
| --- | --- | --- | --- |
| app | `c3369e6d29ba` | `sha256:a7915f9cfba04c7077f5bfe94b18fd0151ad34e6b4f516c023aa85b77b696ddf` | `127.0.0.1:43100` |
| API relay | `0de60ad4a90c` | Same source-pinned app image above | `127.0.0.1:43103` |
| MCP | `3ff91fc6e3e` | `sha256:4472488d600f132b47c3edaea04cb1a613b736e5fb75b977cbe380cea8bb0fc8` | `127.0.0.1:43104` |
| Migrator, completed | One-off | `sha256:ec09a9c61e7ce77dc823af9bd9e2582f2109f38b8a8d15bed113edd530bf285a` | None |
| PostgreSQL15.15 | `b872082621ef` | `sha256:bb506a9728d218a29ad9c1fd7ed6acb713214fa3fe10dbc875c5cd1a865ebb46` | Unpublished5432 |

Program tags are `temcotools-v2-pilot-parallel-{app,mcp,migrate}:48c646fcf43acde8995b028526cb084581f89f4c`; these native classic-Docker configuration IDs differ from local containerd index IDs. PostgreSQL uses immutable upstream digest `sha256:1d1095b0503145be79c79239372aefadfacf6b7c33c9245bbf99ce4b6b89c737`, without replacing the production tag. Actual program runtime is Node24.22.2/Linux/x64, UID/GID1001; shared private files are 0700/0600. Updated app/MCP/relay started 22:20 UTC; the original DB container remains at its 17:31:34 UTC start. All 31 migrations remain applied, with no schema/migration change in this UI refresh.

The three-image archive was transferred and SHA256-verified before load: `e78e2ab3a60741b56430e64be35b4a3fbcfc0ac9faa6f7f9ae8da7ae0d165136`. Native guard render, loaded-image verify and immediate prestart verify passed with sourceState/clean-branch checks retained. The task-private official Node24.22.2 binary runs the same source-pinned guard; no system Node installation or alternate enforcement was introduced.

Production `/srv/temcotools` remains clean published main/fea1f22. App/label/API/DB IDs `00d4d1e637cd`, `410f55a04bd9`, `f8299cd43494`, `a8b7323556b4`, their start times, images and mounts matched the private before/after baseline. Production origin sign-in and both relay health endpoints stayed200. No production container restart, DB/volume/file/key mutation or image retag occurred.

## Qualification and honest limits

- Native source/image guard render, verify and immediate prestart passed. Current private DB/env backup, native image IDs, manifest, rollout and HTTP results: `/srv/temcotools-v2-pilot/candidates/48c646f/`. DB/files/keys/sessions, production containers/source and shared proxy/DNS are preserved. The initial metadata comparison stopped before changes because retained mount records used null/omitted fields and a different order; every recorded field matched after normalization. No safety check was disabled.
- Reused scoped fixture **`20261101-162353-build-34854.json` PASS** on 48c: two-read HTTP consent before MFA, privileged password/TOTP/PKCE, scoped SDK catalog/lookup, admin denial, current-session revocation and pilot effect denial. Actual public HTTPS/native SDK passed with normal headers/default certificate validation; revoked bearer401. Temporary synthetic actor/client removed, baseline counts preserved, effect rows0. Summary: MacDev `Qualification/temcotools-v2-ui-48c646f-20261101/native/native-internal-summary.json`. This is synthetic qualification, not Adam's client authorization.
- Current real public sign-in/discovery200, private controls404 and label socket403 passed. Raw127.0.0.1 Host was rejected 421; configured-public-Host loopback and actual public HTTPS succeeded without weakening Host protection. The browser OAuth callback on 127.0.0.1 is a separate local CLI listener.
- Served assets contain consent progress/focused feedback and initial DMP payload/mapping guidance; build ID `nKqU9OR3nXn2P6EK6DZ7j`. Actual human/device acceptance remains pending. No payload/mapping was auto-published.
- Earlier 5187 native/public SDK, native TLS WS origin isolation and independent Chrome sign-in/discovery remain in [the original launch checkpoint](https://github.com/keen5336/temcotools/blob/ba92d0aa9558978bb9f60e32d3b53e81361467fe/docs/v2/pilot-launch-status.md). Broker/auth/domain/schema/lockfile code and the actual proxy fragment are unchanged by 48c. Earlier 3f98994 phone tests and local arm64/emulated-amd64 rehearsals remain distinct; no real Zebra/CSP/upstream acceptance is claimed.

## Named private owner handoff

Username **adam** / display name Adam is now password-enrolled and the owner reports a successful sign-in. The original code expired; the guarded CLI reissued once at 21:28 UTC at the owner's request, preserving the account ID and invalidating old material. That replacement has since been consumed. No agent chose the password, configured a factor or redeemed a code. Retained private delivery files are historical; do not use or reissue them for this enrolled account.

Local Codex entry `temcotools_v2` is configured at the public MCP URL with **only `workflow.read` and `inventory.read`**. Prior configuration is backed up under MacDev `Qualification/temcotools-v2-mcp-connect-20261101/private`. Both native login attempts timed out without server approval/grants/tokens; neither callback listener remains active. No third automatic attempt or idle retry loop was started. The confirmed approving browser is on the same Mac as Codex, so 127.0.0.1 is the correct local callback, not the public service address.

When ready to approve immediately, Adam runs this in Terminal on the Mac running T3/Codex:

```sh
codex mcp login temcotools_v2 --scopes workflow.read,inventory.read
```

The CLI opens a fresh browser request and waits locally. Approve the two reads there; this initial grant needs no privileged MFA proof. A synthetic actual-HTTP check of that no-MFA read branch now passes. Old pages cannot finish a connection after the listener times out. No agent approves consent or reads human credentials. Add payload administration only through later explicit consent after human authenticator/recovery setup and recent password/MFA confirmation at `/account/security`. `/account/access` manages grants. Check the CLI result and make one actual authorized MCP read before declaring the assistant connected; a supported client refresh may be needed.

Launch preflight after synthetic cleanup remains exit2 only for privileged MFA/recovery custody; password enrollment is complete. Initial read-only OAuth is permitted. The live payload/site-profile catalogs were read back empty: load the built-in DMP executor, save/publish deliberately and add its exact-origin mapping before universal Connect selects it. No upstream read or publication/mapping was silently performed during diagnosis.

After privileged MFA/recovery setup, rerun the existing preflight against **only** the pilot and retain its private receipt:

```sh
ssh -F /Users/openclaw/.ssh/config.codex-isolation-saved-20260814-204227 \
  -o BatchMode=yes -o StrictHostKeyChecking=yes vps \
  'docker exec 3ff91fc6e3e node --import tsx scripts/v2-preflight.ts --expect-database temcotools_v2_pilot_parallel --allow-operational-target --phase launch'
```

The explicit operational-target flag admits only the exact named pilot database; it does not select production. This reads the pinned container's own environment and prints aggregate readiness, without exporting keys. A later replaced container requires its verified current ID. Then follow the [first collaboration session](pilot-runbook.md#first-collaboration-session-after-approved-launch): pair the work browser, explicitly share a named read to the same person's client, or privately intake a body-only JSON/CSV/XML export. Browser DMP login stays on the work machine; server/MCP do not receive its cookies. Route Planner identity/read/complete-route evidence and Ashe's official finals (likely Tuesday) remain separate pending qualifications. No live upstream call, warehouse mutation, email or print was performed during launch.

## Preserve and recover

New pilot environment/keys, database/files and audit/unknown-effect ledgers stay private and retained. To suspend admission, validate and restore **only** the new hostname's saved maintenance fragment, then gracefully reload after checking relevant streams; production routes remain unchanged. Stop only the explicit pilot Compose project if needed. Never use `down -v`, prune, replace production resources or run an old image against a forward-migrated database. The [pilot runbook](pilot-runbook.md) and [cutover package](cutover-runbook.md) retain the concrete recovery boundaries; production cutover is not authorized.

Existing Work recovery/review supervision is active, without guaranteed instant/continuous execution. The T3 queue was read back empty at this checkpoint; no new coordinator, supervisor or idle continuation was created. The next useful source work is evidence-backed DMP normalization/RP qualification when the owner connects or supplies private bodies; do not manufacture mappings while awaiting that human input.
