# Isolated v2 pilot beside production

This package prepares a separate pilot; it does not launch it or expose a public endpoint. Keep published `main`, protected `v1`, the existing production composition and its data/services unchanged. Never merge [the standalone pilot composition](../../deploy/v2-pilot.compose.yml) with `docker-compose.yml`, use the production deploy shortcut, or reuse production environment files, keys, volumes, database connections or image tags.

The existing composition has fixed `container_name: temcotools`, ports3000/3003/3004, a relative `runtime/admin-files` bind and production defaults. The pilot deliberately uses its own project `temcotools-v2-pilot-<slug>`, database, internal bridge, named storage, images, cookie and relay audience. PostgreSQL is unpublished. Only app `127.0.0.1:43100`, DMP relay `127.0.0.1:43103` and authenticated MCP `127.0.0.1:43104` are published. No label relay is defined or proxied. There are no builds, automatic pulls, production mounts, external resources or fixed container names in this file. Automatic restart is disabled for this initial pilot.

## Owner flow and operating boundary

The intended simple flow is: open the distinct pilot site, privately enroll/sign in, set up privileged MFA, then install **Connect Temco** once. Its universal loader selects an explicitly configured site profile and that system's published adapter. The existing DMP-specific bookmarklet remains compatible; do not replace or disable its working production integration. DMP, Route Planner and MARS remain separate system adapters and authority contexts. The universal loader/site-profile package is separate implementation/qualification work; this composition alone does not establish it works.

Pilot runtime mode is `TEMCO_PILOT_MODE=read_only_dmp`: local application workflows may write the **pilot** database, but live printing, live MARS execution and non-GET DMP requests are denied server-side, including MCP/queued dispatch paths. `TEMCO_SESSION_COOKIE_NAME=temco_v2_pilot_<slug>` and `API_RELAY_AUDIENCE=pilot:<slug>` keep browser/relay identity distinct. The main thread owns and qualifies these runtime guards; environment settings alone are not proof of their enforcement. Read-only upstream DMP calls still need an explicitly paired signed-in human and existing origin/named-operation/session checks.

Route Planner's identity/adapter contract is not yet evidenced. Keep its live POSTs disabled; provide review/manual XML intake and diagnostics until qualified, without inventing endpoints, selectors or identity fields. Preserve mid-route pickup/replacement relationships and notes as context rather than collapsing original/replacement units or treating a planned pickup as physical completion. Official finals qualification on Tuesday is a later workflow gate, not a prerequisite for this isolated pilot. No new email/DNS/account provisioning or live operational action follows from this runbook.

## Prepare the reviewable package

1. Choose the pilot slug and **separately approved exact HTTPS hostname**. Compare it with read-only production proxy/resource metadata at the future launch; reject any production hostname, routing replacement or shared resource. This source guard already refuses the known production default `https://temco.chronchive.com`; it cannot infer every real production alias. Do not select or publish DNS in this preparation step.
2. Use a clean `v2` checkout at the exact committed40-character revision to be qualified. Put a private copy of [v2-pilot.env.example](../../deploy/v2-pilot.env.example) outside the repository/build context, in a mode0700 directory with mode0600 file. Fill the exact slug, `PILOT_DATABASE_NAME=temcotools_v2_pilot_<slug_with_hyphens_replaced_by_underscores>`, full image pins, origin and **new distinct** pilot secrets through authorized private delivery. No usable keys or enrollment codes are supplied/generated here. Do not read/copy production credentials to compare them. The guard checks format/distinctness within the pilot, not randomness or production-secret custody.
3. Build the program images explicitly in the separately authorized image-build step. Each name must be `temcotools-v2-pilot-<slug>-app:<fullHEAD>`, `...-migrate:<fullHEAD>` or `...-mcp:<fullHEAD>`. Use `Dockerfile` runner, its `migrator` target and `Dockerfile.mcp` respectively. Supply `--build-arg VCS_REF=<fullHEAD>` and explicit overrides `--label com.temcotools.deployment-role=pilot --label com.temcotools.production-eligible=false` on **all three**. Keep build context clean and private files outside it. Record exact local `sha256:` image IDs privately; guard verification requires those IDs plus OCI revision/pilot labels. The fixed PostgreSQL upstream digest is in the composition; record its exact local image ID too. Acquire missing images only as an explicit build/acquisition operation, never through pilot `up` or this helper.
4. Render to a **new** private receipt directory and review the captured configuration/manifest. Resolved Compose configuration contains secrets; never paste it into chat, logs, Git or a public issue. The helper prints only a safe summary. It never opens network listeners, contacts upstream APIs, builds, pulls, migrates or starts containers.

```sh
# Preparation only. Set these nonsecret shell variables to the selected paths,
# exact committed revision and already chosen local Docker context.
dev-run -- npx tsx scripts/v2-pilot.ts render \
  --env-file "$pilot_env" --expect-source "$pilot_head" \
  --output-dir "$pilot_receipt_dir"

dev-run -- npx tsx scripts/v2-pilot.ts verify \
  --env-file "$pilot_env" --expect-source "$pilot_head" \
  --manifest "$pilot_receipt_dir/manifest.json" \
  --docker-context "$pilot_docker_context"
```

`render` validates the fully resolved standalone composition and captures `resolved.compose.json` plus a manifest (both0600, directory0700). The manifest pins source, composition/guard hashes, exact intended image IDs, isolation settings and resolved-config hash. `verify` requires the same reviewed inputs/source/config, an explicitly named **local Unix-socket** Docker context, actual image ID/revision/pilot labels, existing pilot volume/network ownership and no foreign Docker project publishing the pilot ports. It inspects selected metadata only, without reading production environment/container contents or host files. A non-Docker host listener, host capacity, actual readiness, approved proxy/domain and real secret custody are still future launch checks. Never stop another service to satisfy a port check. Existing resources with missing/wrong pilot labels are refused rather than adopted or removed.

Any source, private setting, image ID or resource change requires a new receipt and review. Re-run verification immediately before an authorized launch; the guard does not lock the Docker daemon or make a later command atomic. Use only this exact `-f` file, explicit project/context and private environment; do not add overrides or inherit `COMPOSE_FILE`/production settings.

## Future private launch, enrollment and qualification

These are concrete future steps after the selected source/images, private credentials, host/resource inventory and launch authority are ready. None was executed for this package. Public proxy exposure remains a separate gate.

Use a shell array for the exact standalone invocation, with no secrets on the command line:

```sh
pilot_compose=(docker --context "$pilot_docker_context" compose \
  --env-file "$pilot_env" --project-name "$pilot_project" \
  -f deploy/v2-pilot.compose.yml)

# Only after the future launch gate; images must already be local and verified.
"${pilot_compose[@]}" --profile maintenance run --rm --no-deps storage-init
"${pilot_compose[@]}" up -d --no-build --pull never db
"${pilot_compose[@]}" --profile maintenance run --rm --no-deps migrate
"${pilot_compose[@]}" up -d --no-build --pull never app api-relay mcp-http
"${pilot_compose[@]}" exec -T mcp-http node --import tsx scripts/v2-preflight.ts \
  --expect-database "$pilot_database" --allow-operational-target --phase migrate
```

`storage-init` only sets1001 ownership/mode0700 on the new pilot admin-files named volume, with no network. It does not mount host/production files. Migration acts only on the pilot's internal `db` URL. Start with a fresh pilot database; production copies/backfills need their own deliberate protected-data/restore review. Follow the [cutover/recovery runbook](cutover-runbook.md) for actual enrollment and backups. Initial `v2-bootstrap.ts` is dry-run by default, requires the exact database and explicit operational-target guard, creates no public default PIN/password and does not impersonate the owner. Before any future `--apply`, prepare a protected persistent delivery destination and delivery procedure; an auto-removed one-off container must not be the only copy of its one-use code. Deliver privately, let the named person set their password at `/signin/recovery`, then enroll MFA and save recovery codes at `/account/security`. No agent should read/redeem the owner's code, pick their password, self-approve MCP consent or send it in a tool result.

After enrollment, run `v2-preflight.ts` with the same exact pilot target and `--phase launch`. Qualify real pilot runtime boundaries with synthetic accounts before admission: distinct cookie/audience, current role/session revocation, UI-context cross-tab rejection, explicit OAuth/PKCE consent at `/account/access`, bearer-only `/mcp`, shared command/query parity, and denial of direct/queued print, MARS and non-GET DMP effects. Keep source/native fixture tests, actual local HTTP/SDK results, public proxy results and real operator/Zebra acceptance distinct. Test DMP pairing only when the real signed-in page/authority is available; no speculative Route Planner identity or automatic POST is enabled to make a test pass.

The [Caddy example](../../deploy/v2-pilot.Caddyfile.example) is a review-only **new-vhost** fragment. It routes `/mcp`, SDK OAuth endpoints and discovery to43104; `/api/api-relay/ws` to43103; everything else, including human consent, to43100. It preserves public Host and explicitly denies the label-relay socket. Never route `/account/authorize` or `/api/oauth-consent` to MCP. Validate the final proxy config and owner-approved host against existing production metadata before any future reload; no wildcard catch-all, production vhost replacement, label proxy, DNS/certificate/resource change or public reload is authorized by source preparation.

## Stop, restore and rollback

Stop only the explicitly selected pilot services/project after checking ownership. Preserve the database/admin-files volumes, private environment/MFA key, image IDs, migration history, enrollment custody and audit/unknown-effect ledgers. Do not use `down -v`, prune resources or run an old app against a forward-migrated database. Production keeps running independently. For a failed migration, stop pilot admission, preserve diagnostics and rehearse a dump/restore into a **new isolated pilot target** before choosing an older source image; use the established cutover recovery boundary. Unknown upstream/print outcomes are never retried by restart/restore. This package adds no automatic cleanup, background deployment or public exposure.

## Qualification recorded for this package

The focused native suite renders this actual standalone file with Docker Compose5.3 and public synthetic fixture values, then verifies the accepted isolated graph and fail-closed production-origin/image/DB/mount/network/port/mode/cookie/audience changes. It checks exact-image metadata rules with synthetic metadata; no real pilot image or runtime is claimed. No production metadata probe, private environment read, key/enrollment generation, host probe, container startup, migration, DNS/proxy change or upstream/device action occurred. Current build status carries the integrated runtime qualification; a source render does not establish a usable deployed pilot.
