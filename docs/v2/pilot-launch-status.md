# Parallel pilot launch and first-account handoff

**Live isolated pilot:** https://temco-v2.chronchive.com/ · **MCP:** https://temco-v2.chronchive.com/mcp. Current application/image source is `d2614520cb1f72e0515ce2b05a018dab5ac3921e`; later documentation commits do not change that runtime. Native expanded release, public scoped SDK and actual public both-engine scanner inference passed; earlier48c release records below are historical. Adam completed password activation; his client consent and privileged MFA remain human steps; full v2/upstream/device acceptance is not complete.

## Authority and actual routing

Adam answered **“Yes I approve”** to the exact new-host DNS and isolated-pilot launch question. This cleared the earlier automatic approval rejection. The coordinating root created only the new proxied A `temco-v2.chronchive.com` → `15.204.239.71` at 17:27:41 UTC on 2026-11-01, record `eff39ea73f2fda45b9504b2bd3d15d0c`. DNS has one writer; do not duplicate it. Production `temco.chronchive.com`, main/v1, paid services, mail and real operational effects are outside this pilot change.

Strict known-host SSH uses the existing saved configuration: `ssh -F /Users/openclaw/.ssh/config.codex-isolation-saved-20260814-204227 -o BatchMode=yes -o StrictHostKeyChecking=yes vps`. Its actual target is `ubuntu@15.204.239.71`. No production secrets/browser sessions were copied.

The exact new Caddy vhost now routes UI/human consent to loopback43100, MCP/OAuth/discovery to43104 and only the exact `/api/api-relay/ws` and `/api/integration-relay/ws` paths to43103, preserving the public Host. Private `/control`, `/api/internal/*` and relay-control aliases return404; the label socket returns403. There is no production fallback. Origin HTTPS and independent real Chrome verified valid TLS, sign-in and discovery. Python urllib's Cloudflare1010 was retained as a client-specific failed probe; actual public native fetch/SDK passed with its normal headers and certificate validation. No WAF/BIC/TLS weakening or browser-UA substitution was used.

Root-private proxy/TLS backup: `/root/temcotools-v2-pilot-backup-20261101/caddy-before.tar`, with original configuration, maintenance fragment and validation/reload logs. Parent Caddyfile SHA256 remains `0f15706104853b5cc0f4707c7d3b694f25605ee930a471238760d5e930a154f4`: original bytes plus only the new explicit import. The initial Nov1 admitted fragment SHA256 was `5d82512a4a074c1fe4ce04770b6beedd775113d87e40a91009b9d00893cad8a1`. The Nov3 exact second browser-relay path changes only this pilot fragment to `585fde6508e66eaa75db7e7a98534635304806f5821d2db9f0b6f412f4544b9d`; parent/production configuration is unchanged. The prior fragment is private at `artifacts/d261452/proxy-before.caddy`. Full configuration validation and graceful reload passed; no established production3002/3003 upstream streams were present immediately before it.

## Nov3 provider/template release — current native runtime

**Live image/source `d2614520cb1f72e0515ce2b05a018dab5ac3921e`**, deployed November3 at21:49–21:50 UTC. This includes native printer queues, real internal workflow actions, the durable generic provider lifecycle and platform/site templates. Earlier2ae/7d releases remain distinct history;7d fixed timezone hydration and first passed actual public both-engine inference.

| Service | Container prefix | Native amd64 image ID |
| --- | --- | --- |
| App | `26217ef01a0e` | `sha256:c42a4fdd7d56446e92e38d118ba1ef5ecfaadb60d33ecbfe09e3bc3eda47c930` |
| DMP/generic browser API relay | `d1a06bb4eebc` | `sha256:b49c4159b76dd8b1615cc72617b2ea299ddf42394ee3c65c482e91395d2411d1` |
| MCP HTTP | `becf1236354a` | Same pinned full MCP image above |
| Migrator, completed | One-off | `sha256:18e8907f3332e1392e1ad6cf49c166cfaed88f3f6d0b62851317e6d5cc7ee2df` |

The API relay deliberately now uses the existing full MCP service image/Prisma runtime, not the app image. Its exact command is `node --import tsx scripts/api-relay/runtime.ts`. Legacy DMP and generic provider transport retain separate control/identity/grant semantics and distinct audiences; the proxy exposes only the two exact socket paths. No label-relay service runs.

Original DB `b872082621ef` retains its November1 start. All38 migrations are applied with no pending/failed/checksum/unknown entries. Preflight verifies75/75 forced operational RLS tables, a restricted ordinary runtime role and the reviewed bounded report/coordination function owners. Owner identity/password/PIN envelope/factors/recovery/session/grant fingerprint matches the private pre-release state. No enrollment/reset or owner impersonation occurred. Production container IDs/images/start times/mounts/ports, main/fea1f22 and parent proxy bytes match before/after; production sign-in200. Main/v1 remain protected.

Native source/image/branch/resource/port guard render+verify passed. Private release artifacts/logs: `/srv/temcotools-v2-pilot/artifacts/d261452/`; guard `/srv/temcotools-v2-pilot/receipts/render-d261452/`. The first host guard command assumed `tsx` was installed in the source checkout; it stopped before service changes. The same pinned guard ran successfully with the task’s official Node24 built-in TypeScript support. No host package install or alternate validation was introduced. The migrator ran once with stdin disconnected, then only pilot app/API/MCP were replaced.

Current qualification:

- **Actual public Chrome5/5 PASS**, `20261103-155230-build-1624`:390px/Auckland timezone, password sign-in for temporary synthetic people, anonymous/site-admin Lab denial, cross-tab/RSC warehouse pinning, deployed provider/template screens and generic executor source, BOTH real Tesseract+Paddle workers on the same synthetic serial image. External OCR requests0, React errors0, overflow0; raw misreads preserved. Synthetic people/sessions/sites all0 after cleanup, effects0, Adam unused. This is actual public software execution, not a handheld benchmark.
- **Native/public actual SDK PASS**, `20261103-155258-build-1996`: Linux/x64/UID1001 Node24.22.2, password/TOTP/PKCE, two-read consent before MFA, scoped SDK, current-session revocation and pilot-effect denial. Actual public HTTPS used normal native fetch/SDK headers/default certificate validation; revoked bearer401. Temporary synthetic actor/client removed; other actor counts preserved and effect rows0. Private summary: MacDev `Qualification/temcotools-v2-providers-d261452-20261103/native/native-internal-summary.json`. This is not Adam’s client attachment. Earlier2ae SDK84433 and7d public89132 are historical separate checks.
- Public `/control` and internal callback404, label socket403, unauthenticated MCP401. Both DMP/generic **WebSocket upgrades** from an unconfigured synthetic origin403; ordinary GET on those socket-only paths404. The initial GET-only probe expected403 and was corrected to test real WebSocket upgrades. No WAF/BIC/TLS weakening occurred.
- All26 native model/runtime hashes pass,117,792,876 bytes, pinned Paddle0.4.2/ORT1.24.3/Tesseract7.0.0. Models/workers stay lazy on the pilot origin; actual public inference ran. Physical Zebra/Android/iPhone/camera benchmarking remains pending.
- Owner MFA remains unconfigured. Migrate preflight has no blockers and warns privileged MFA/recovery custody is pending. Existing password login/read-only MCP consent remain usable; protected publication/sharing requires Adam’s own current password/authenticator ceremony at `/account/security`. No agent configures that factor.

Usable paths: [TemcoScan Lab](https://temco-v2.chronchive.com/tools/scan-lab), [Workflows and Receiving practice](https://temco-v2.chronchive.com/tools/workflows), [Warehouse settings](https://temco-v2.chronchive.com/management/warehouse), [Connections/actions](https://temco-v2.chronchive.com/management/connections), [Templates/defaults](https://temco-v2.chronchive.com/management/templates), [Payloads](https://temco-v2.chronchive.com/admin/payloads), [MCP setup](https://temco-v2.chronchive.com/account/access). [Provider guide](provider-connection-guide.md) explains actual activation vs configuration. No approved upstream mapping/provider is silently seeded; Route Planner/WMS/MARS qualification, official finals and device acceptance remain pending. Workflow-to-provider outbox execution and controlled unit custody remain source-independent implementation packages, not owner-evidence gates.

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

## Historical48c qualification and honest limits

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

Existing Work recovery/review supervision is active, without guaranteed instant/continuous execution. The T3 queue was read back empty at this checkpoint; no new coordinator, supervisor or idle continuation was created. The Nov3 expanded build remains active: generic provider activation/durable dispatch, supported workflow building blocks, platform/site defaults and controlled custody are independent implementation packages. Missing upstream identity/receipt/close evidence and physical-device acceptance gate only their dependent live behavior. Do not manufacture mappings or stop the independent program awaiting owner MCP consent.
