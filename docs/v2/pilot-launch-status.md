# Parallel pilot launch checkpoint

Selected origin: `https://temco-v2.chronchive.com`, on existing `15.204.239.71`. The coordinating root verified the exact production proxied A record and absence of the new record. **DNS was not created:** automatic approval review rejected the proposed new record because retained deployment/DNS authority was judged insufficient. The coordinator has requested explicit owner approval. Until it arrives, preserve the existing maintenance vhost/backups and make no further live host/proxy or public-service changes. Private staging and local qualification continue; full v2 and public pilot acceptance are not complete. DNS has one writer, the coordinating root.

## Verified host and preserved production

Relevant deployment history identified the existing saved SSH configuration: `ssh -F /Users/openclaw/.ssh/config.codex-isolation-saved-20260814-204227 vps`. Its resolved target is exactly `ubuntu@15.204.239.71`; batch access succeeded with existing known-host verification and `StrictHostKeyChecking=yes`. No private key contents or production environment values were extracted. A missing default `vps` alias is no longer an access blocker.

- Native host: Linux/x86_64, four CPUs, about7.9 GB RAM/5.2 GB available and20.6 GB free at inspection. Docker29.1.3, Compose2.29.2, Caddy2.11.2. These are observed capacity figures, not a free-space policy.
- `/srv/temcotools` remains clean published `main` at `fea1f22af1b2fae788388f2aefed3e3998e98d09`. Production app/label/API relay/DB container IDs remained `00d4d1e637cd`, `410f55a04bd9`, `f8299cd43494`, `a8b7323556b4` before/after the maintenance-vhost change. No production container restart, DB/volume/file/image/key change occurred.
- Verified production **origin HTTPS** sign-in200 and existing relay health200 on3002/3003. Cloudflare edge requests from the inspection host returned403 before changes; this is not a claim of public-client200. No edge policy was changed or bypassed.
- Root-private Caddy configuration/TLS backup: `/root/temcotools-v2-pilot-backup-20261101/caddy-before.tar`, with original config and private validation/reload logs retained. Original Caddyfile SHA256 `6a65d44147da349cc9300706f16e13548e5c5f67630319dee000e2d2a21c3864`; append-only result `0f15706104853b5cc0f4707c7d3b694f25605ee930a471238760d5e930a154f4`. Original bytes were preserved; only the new explicit import was added.

## Maintenance admission, already verified

`/etc/caddy/sites/temco-v2.caddy` serves only the exact new hostname over HTTP/HTTPS, with an uncached503 maintenance response and no backend/default-account access. `/control`, `/api/internal/*`, relay-control aliases and the label socket return404. It cannot fall through to production. Configuration validation and graceful reload succeeded; direct HTTP Host tests returned the expected503/404, and production origin/relay/container checks remained unchanged. No public DNS or new-host certificate/client success is claimed.

The DNS-ready signal supplied to the coordinator is: **new hostname cannot fall through to production; required origin IP15.204.239.71**. It does not override the subsequent approval rejection. Preserve this maintenance state until explicit authority arrives.

Caddy closes proxied WebSockets on configuration reload by default ([official directive documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#streaming)). No established production3002/3003 upstream connections were present immediately before this reload. Recheck relevant active streams before a later approved admission change; do not treat idle inbound Cloudflare TLS sockets as proof of an upstream operation.

## Pinned private staging

Application/image source remains `5187dc08422aad71b6fc0962364a24704c0d1b2f`; documentation/proxy-template commits may be newer. The separate `/srv/temcotools-v2-pilot/source` clone has local `v2` pinned to5187 and is clean. No reset or edit was made to the production checkout.

Local MacDev artifacts/receipts: `/Volumes/MacDev/ProjectArchive/Development/Qualification/temcotools-v2-pilot-launch-20261101/`. New target staging is `/srv/temcotools-v2-pilot/{artifacts,private,receipts}` with a private parent. Files stay outside Git. Program tags are `temcotools-v2-pilot-parallel-{app,mcp,migrate}:5187dc08422aad71b6fc0962364a24704c0d1b2f`, with pilot/nonproduction labels.

- Explicit Linux/amd64 builds passed: app `20261101-105237-build-54352.json`, MCP `105214-build-54354`, migrate `105208-build-54353`. Local AMD64 Node24/x64/fresh31-migration/HTTP/storage qualification passed `110158-build-56488`; password/TOTP/PKCE/scoped SDK/current revocation/pilot denials passed `110238-build-57060`. Program images executed under emulation on the local aarch64 Docker daemon; PostgreSQL was explicitly arm64/15.15. Frozen source/helper metadata passed `110028-build-56062`; formal CLI sourceState was not run for that local fixture. All four local task containers were verified stopped `110455-build-57398`, with no owner/effect rows remaining. Evidence: `Qualification/temcotools-v2-pilot-amd64-5187dc0-20261101`. These are not native VPS, public TLS/DNS or real owner-client results.
- Image archive: `pilot-5187-amd64-images.tar.gz`,1,041,437,346 bytes, SHA256 `926393c4e162f3f1e3155a19d3abce9be5b73d0a2aaac110cfbce9b0dceb6f24`. Docker-save configs independently identify Linux/amd64, source5187 and pilot/nonproduction labels. Target-classic image config IDs expected after load are app `sha256:52d2654c9a9cf80aea93050f5d5d4ce755df43bf0ea22f52697d6f16d09a8f1f`, MCP `sha256:420095592ef3e05175dd7b2279b51a092e0f28064d7655b93ec2bb4b07082e18`, migrate `sha256:b7d39c64691355f9e9910c050b9d9a5d69b006a9d811d9eb156f6591de25552a`. Do not confuse these with local containerd index IDs; inspect actual loaded metadata before final binding.
- The intended host has no system Node/npm. A task-private Node24.22.2 Linux/x64 archive was obtained from the [official distribution](https://nodejs.org/dist/v24.22.2/) and checked against its HTTPS SHASUMS256: `48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75`. It requires no system installation. The bundled guard calls the same5187 `runPilotCli`, retaining its source/clean-branch checks; original guard source SHA256 `afab8c7de2ad0cd19523769518c203144f887c783ce027af830d8c7c597ed1c9`. Artifact hashes stay in the private receipt.
- Planned project/DB: `temcotools-v2-pilot-parallel` / `temcotools_v2_pilot_parallel`, dedicated DB/admin-files volumes and bridge, new session/MFA/DB secrets, `temco_v2_pilot_parallel` cookie, `pilot:parallel` relay audience, `TEMCO_PILOT_MODE=read_only_dmp`. Preserve production resources and use no production secret/environment file. No owner account, enrollment code or client consent has been created.

Private target staging completed without loading images or starting services: the full image archive arrived with matching size/SHA256; the standalone guard/official Node archive hashes were verified, and the private Node binary reports native Linux/x64/v24.22.2. The actual host clean5187 source passed the guard's **configuration-only render** into `/srv/temcotools-v2-pilot/receipts/render-staged`; sourceState checks were retained. Private pilot keys/environment are staged0600 outside the source, parent0700. This manifest uses expected image config IDs; after an approved load, inspect/rebind actual IDs and create a fresh final receipt before `verify`. No native application-image execution/loaded-image verification or public admission is claimed.

## Smallest remaining launch sequence

These are **pending explicit approval**, not instructions to bypass the rejection. After the coordinator receives it:

1. Verify staged archive checksums, load only the three pilot tags, inspect native amd64/revision/pilot labels and exact IDs, and retain their metadata. Confirm the existing pinned PostgreSQL15 image by digest/native ID without pulling/replacing its production tag.
2. Finish the private `pilot.env` binding, using its new independent keys. From the pinned source, run the private Node/guard CLI `render` into a new private receipt, then `verify` with the explicit local Docker context. A staged configuration-only receipt does not prove loaded images or readiness. Recheck dedicated ports/resources and immediately verify before launch.
3. Use only the standalone [pilot composition](../../deploy/v2-pilot.compose.yml): `storage-init`, fresh DB, pinned migrator, then app/API relay/MCP. Run the [runbook](pilot-runbook.md) commands with the exact project/env/source. Keep all host bindings loopback and PostgreSQL unpublished. First qualify native host HTTP/OAuth/SDK/current-role/revocation/effect-denial paths with temporary synthetic accounts; clean those fixtures.
4. Coordinate the **single** new proxied A record with the DNS owner. Verify real DNS/TLS separately. Replace only the new maintenance fragment with the reviewed pilot routes once admission is ready; continue explicit404 for `/control` and `/api/internal/*`, deny printing, and verify production before/after. A CNAME/A record alone does not create the vhost.
5. Deliver initial named enrollment privately only when the intended person/delivery path are ready. Never choose/redeem their password/MFA/consent. Allow human setup through the approved origin, then run launch readiness before operational admission. Complete actual owner/client MCP attachment separately from synthetic SDK qualification. The work DMP browser keeps its own upstream session and pairs/shares reads explicitly; RP live contracts and official finals remain independent evidence gates.

For the already staged standalone guard, the exact post-approval configuration commands are:

```sh
pilot_root=/srv/temcotools-v2-pilot
pilot_head=5187dc08422aad71b6fc0962364a24704c0d1b2f
pilot_node="$pilot_root/tools/node-v24.22.2-linux-x64/bin/node"
pilot_docker_context=default # Confirm this is the host's local Unix-socket context.
cd "$pilot_root/source"
"$pilot_node" "$pilot_root/artifacts/v2-pilot-guard.mjs" render \
  --env-file "$pilot_root/private/pilot.env" --expect-source "$pilot_head" \
  --output-dir "$pilot_root/receipts/render-final"
"$pilot_node" "$pilot_root/artifacts/v2-pilot-guard.mjs" verify \
  --env-file "$pilot_root/private/pilot.env" --expect-source "$pilot_head" \
  --manifest "$pilot_root/receipts/render-final/manifest.json" \
  --docker-context "$pilot_docker_context"
```

Load/inspect and bind the approved image IDs **before** this final receipt, without reusing an existing receipt directory. Continue with the exact standalone Compose array/launch commands in the runbook; neither guard command launches a service. Private future admission artifact `/srv/temcotools-v2-pilot/private/proxy-admission.caddy` has SHA256 `5d82512a4a074c1fe4ce04770b6beedd775113d87e40a91009b9d00893cad8a1`, generated from the current reviewed example and not applied. Its explicit private-control404 rule is part of deployment configuration; the application/image revision remains5187.

The supervisor remains active for recovery/review. Do not create another coordinator, DNS writer or idle retry loop. A supplied explicit approval resumes useful launch work directly; no request to say “continue” is needed.
