# Authenticated remote MCP

Implemented source: the installed MCP SDK's `mcpAuthRouter`/`OAuthServerProvider` and stateless `StreamableHTTPServerTransport`, backed by the existing application's PostgreSQL identity/session/command layer. This is an additional process in the existing application composition, not a new identity platform. Production deployment and actual external-client/operator acceptance remain pending.

## Configure and run

Apply the ordinary Prisma migrations, including `20261101100000_authenticated_mcp_oauth`, before enabling this process. Preserve the application's user IDs, session state, access generation and audit history. Use the same database and configuration in the Next app and MCP process:

| Setting | Required value |
| --- | --- |
| `MCP_ISSUER_URL` | Explicit HTTPS origin root, such as `https://warehouse.example/`. |
| `MCP_RESOURCE_URL` | That origin's exact `/mcp` URL. No query, fragment or embedded credentials. |
| `NEXT_PUBLIC_APP_URL` | Existing application origin root, matching the production issuer origin. Different HTTP loopback ports are allowed only for local tests. |
| `MCP_HTTP_PORT` | Loopback listener port; default `3004`. |
| `MCP_HTTP_HOST` | Default `127.0.0.1`. A private Docker service may explicitly use `0.0.0.0`, with only a host-loopback published port/private proxy route. |
| `DATABASE_URL` | Existing private PostgreSQL target. Never provide it to MCP clients. |
| `SESSION_SECRET` | Existing application cookie/identity secret, securely delivered. |
| `MFA_ENCRYPTION_KEY` | Preserved 32-byte base64url encryption key for production authenticator enrollment. Keep it separate from cookie-key rotation. |

Start with `npx tsx scripts/mcp-http-server.ts` (or the composition's equivalent). The process defaults to loopback and accepts only the configured public Host header. A private container can explicitly bind its internal interface while publishing only on host loopback; verify that exact composition instead of assuming one container can reach another's `127.0.0.1`. Main deployment composition changes are separate from this source implementation.

Route only these public paths to this process through the existing HTTPS proxy, preserving Host:

- `/mcp`
- `/authorize`, `/token`, `/register`, `/revoke`
- `/.well-known/oauth-authorization-server`
- `/.well-known/oauth-protected-resource/mcp`

Keep `/account/authorize`, `/api/oauth-consent`, account security and all ordinary UI/API paths on Next. The consent page requires `frame-ancestors 'none'` / `X-Frame-Options: DENY`. Application cookie mutations retain exact-origin/CSRF checks. MCP uses bearer credentials exclusively and ignores cookies. CORS grants no application authority.

Do not deploy, alter DNS, provision services or print production secrets to prepare this runbook. When an authorized launch actually needs credentials, use the runtime's `request_secret` mechanism and secure delivery, not chat or a committed file. Confirm the exact account/domain/proxy configuration at launch.

## Client and consent flow

The SDK publishes authorization-server and protected-resource metadata. Public clients register through its `/register` handler with `token_endpoint_auth_method: "none"`, a meaningful client name and exact HTTPS redirects or HTTP loopback callbacks. Embedded credentials, wildcard hosts, fragments, unsafe schemes and redirect URIs preloaded with OAuth response parameters are rejected. This version supports authorization-code PKCE and refresh, not client-credentials or a shared administrator credential. Client registration itself grants no access.

Clients request a known scope set and the exact `resource` at authorization and token/refresh exchange. S256 PKCE is mandatory and verified by the maintained SDK. Authorization redirects to the phone-sized `/account/authorize` page. A person signs in if needed, sees their current identity, client-defined name, client ID, callback address, resource and requested scopes, chooses a subset and explicitly approves or denies. The request binds to that real user/session; switching users or sessions requires starting again. Approval never happens automatically because a prior grant exists.

Privileged scopes—including account/client administration, user/access management, payload code publication, labels management, identity correction, office authority and dispatch allocation/sign-off—require recent password and second-factor proof. First authenticator enrollment remains accessible to a signed-in person using their current password; confirmation establishes the second factor. Ordinary warehouse lookup scopes do not force scanner-wide passkey enrollment.

Consent initiation/status and authenticator handoff may be described by MCP, but a delegated grant cannot call the consent approval service to approve itself. Passwords, TOTP secrets, one-use enrollment/recovery codes and authenticator ceremonies belong in the authenticated human UI, not tool results or prompt text. A browser cookie is not a substitute for a client grant at `/mcp`.

Active people intrinsically receive `account.self` to secure their own sessions even if warehouse bundles are removed. OAuth/AppAccessGrant scope intersection strips it unless explicitly granted. Delegating this scope requires privileged consent; a warehouse-read grant cannot revoke sessions, mint additional grants or administer other connected clients. No migration silently adds it to existing client scopes.

## Lifetime, revocation and retries

- Consent requests last 10 minutes; authorization codes last 2 minutes and work once. Only hashes of codes/access/refresh tokens are stored.
- Access tokens last at most 10 minutes. Refresh/grant authority never outlives its consenting individual session (12-hour absolute limit, 30-minute acknowledged-activity idle policy).
- Every MCP request and application command resolves current user active state, access generation, assigned bundles, issuing session, client state, grant resource/issuer, expiry/revocation and scope intersection. MFA recency comes from the current server session, not token text.
- Tokens do not keep an idle human session alive. Lock, logout, recovery/access changes, revocation or session expiry end delegated access. The client must return to the human authorization flow when required.
- Refresh tokens rotate once. Reuse—including simultaneous refresh of the same token—commits revocation of the entire grant family before returning an OAuth error. The first response may contain a replacement that the competing reuse has already revoked; do not retry the old token. Reauthorize with the person.
- Refresh can narrow current scopes and cannot enlarge them. Old tokens and queued commands are bounded by the newly narrowed grant.
- A user lists/revokes their grants at `/account/authorize` without a request parameter. Revocation affects existing and queued work through the shared writer/dispatch guard. Possessing an operation/grant ID grants no receipt or action access.
- The existing application operation/event IDs still govern warehouse retries. OAuth token refresh never replays a print, MARS mutation, scan or workflow command. Unknown physical/external outcomes retain their existing reconciliation rules.

## Integration interfaces

`lib/oauth/http-server.ts` exports `createMcpHttpApp(config)` for the process and actual HTTP tests. `TemcoOAuthProvider` implements the SDK provider; protocol route parsing, client middleware, S256 validation, discovery and endpoint rate limits remain SDK code.

`lib/oauth/service.ts` exports `getOAuthConsent`, `decideOAuthConsent`, `listOAuthGrants`, `revokeOAuthGrant`, and reexports token/grant validators. Approval requires a nondelegated current browser session; the MCP action registry must not expose a way to manufacture this approval.

`lib/oauth/grants.ts` exports:

- `authenticateOAuthAccessToken(token, config?)`: fresh scoped `Principal` for a bearer request.
- `principalForOAuthGrant(tx, rawGrantId, config?)`: current authority under user/session/grant/client locks, without calling the generic identity guard recursively.
- `assertOAuthGrant(tx, principal, capability?)`: validates ownership and intersects the entry principal's scope with current grant scope.

OAuth principals carry `grantId: "oauth:<id>"`, `sessionId`, current capabilities and server-derived password/MFA timestamps. The shared `assertCurrentPrincipal` handles this namespace and ordinary AppAccessGrant IDs inside writer transactions. Printer/DMP dispatch must use that same current guard before actual send. Do not treat an OAuth grant ID as an AppAccessGrant row or drop it while copying a principal.

The MCP resource authenticates before parsing up to the application's 50 MiB JSON/import boundary, and each tool uses `createApplicationMcpServer(authenticate)` to recheck current authority. The process does not gain camera, scanner or LAN-printer access; device-bound commands still require an authorized connected device and honest evidence.

## Verification and release limits

Use the isolated local `temcotools_v2_test` database. After a fresh production Next build, run:

```sh
IDENTITY_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/temcotools_v2_test dev-run -- npx tsx --test scripts/oauth.test.ts scripts/oauth.integration.test.ts
```

The HTTP suite launches and closes its own loopback SDK and production Next processes. It exercises discovery/registration, unsafe redirects, S256/resource checks, actual cookie-authenticated phone consent and CSRF denial, code exchange/reuse, real shared MCP queries, scope/audience denial, current-writer revocation, refresh rotation/reuse/concurrency, actual synthetic authenticator proof through HTTP and disabled-client/locked-session denial. It never follows the synthetic external callback URL or calls live DMP/MARS, mail or printers.

These tests establish source/local protocol semantics. They do not establish production DNS/TLS/proxy configuration, real-client interoperability, device/operator acceptance or external warehouse-system qualification. Before launch, verify those concrete paths and recovery material separately under explicit authority. Back up private PostgreSQL state and the preserved MFA key; restoring old session/grant records or stale token rows can revive authority, so invalidate/reconcile them deliberately after a restore. Retain identity audit and relevant failed diagnostics; remove expired transient authorization/token rows only under a bounded reviewed retention job.

## Container candidate

`Dockerfile.mcp` now copies the actual `prisma.config.ts` and runs with the same UID/GID 1001 as the Next container for shared file custody. The `mcp-http` Compose profile publishes only host loopback port 3004; the Caddy example forwards MCP/OAuth/discovery paths while preserving the public Host. Both app and MCP receive the same explicit issuer/resource and MFA settings. The candidate uses Node 24 LTS because the previous Node 20 line is end-of-life ([official release schedule](https://github.com/nodejs/Release)). Container build/start and reverse-proxy qualification must be reported separately from local source checks. No production configuration was applied.
