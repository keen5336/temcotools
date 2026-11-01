# TemcoTools

Warehouse operations application built with Next.js, React, TypeScript, Tailwind, Prisma and PostgreSQL. `v2` is the active integration branch. Published `main` and the preserved `v1` baseline are not advanced by this build.

Start with [build status](docs/v2/build-status.md) for implemented/tested behavior and remaining qualifications. The [strategy](docs/v2/strategy.md), [implementation plan](docs/v2/implementation-plan.md) and [bounded open questions](docs/v2/open-questions.md) describe the agreed operational model. `REPO_MAP.json` is older orientation material; actual source and the v2 documents take precedence.

## Development

Use a mounted MacDev checkout and `dev-run -- <command>` for substantial local builds. The container candidate uses Node.js 24 LTS; local source checks and container qualification are reported separately in build status. Use an isolated PostgreSQL database containing synthetic data, never a production URL for tests.

```sh
npm ci
cp .env.example .env
# Fill private development settings outside version control.
dev-run -- npx prisma migrate deploy
dev-run -- npx prisma generate
dev-run -- npm run dev
```

`DATABASE_URL` and a private `SESSION_SECRET` of at least 32 characters are required. Production also requires the preserved independent `MFA_ENCRYPTION_KEY` (32 bytes encoded as base64url). `.env.example` contains no working credentials. Compose requires an explicit database password and URL; it does not rotate an existing database volume's password.

There is no default public account or PIN. Follow the [cutover/recovery runbook](docs/v2/cutover-runbook.md) for default-dry-run preflight, explicit private-file initial enrollment, conservative backfill, backup/restore and recovery. `npm run bootstrap -- …` uses that guarded workflow. Legacy `BOOTSTRAP_ADMIN_PIN`, `1234` and password-environment bootstrap instructions are obsolete.

## Identity and access

People sign in using an individually enrolled strong password/passphrase. Encrypted cookies identify revocable server-side sessions; active state, access generation and capability bundles are checked against current database state. Account changes affect existing sessions and delegated clients.

Use **Account security** for password/authenticator setup, one-use MFA recovery codes, current sessions, shared-device lock/switch and revocation. Sensitive administration requires recent password and authenticator proof. Assisted reset/enrollment is a one-use private handoff; transactional email is not configured by this build. Coarse legacy roles remain compatibility labels; server actions enforce current capabilities and scoped grants.

## Operational workspace

Home shows authorized operational priorities, pick progress, source freshness, physical-event counts and label follow-up. Customize authorized widgets and keep useful tools in account-saved Favorites. Drawer/navigation follows current capabilities.

- **Warehouse Lookup / Observations:** typed LPN/MSN/serial/submission links, separate order candidates, retained source history, attributed physical evidence and corrections. Device queues preserve original operator/event IDs across reload. A source row is not proof of physical stock.
- **Inventory Audit / Put Away:** one shared accepted WMS import feeds saved views; source revisions, full rows and independent scans remain available. Historical/delivered rows are not all current stock. Inventory Audit keeps the reported/Pick-Wave board and adds shared physical views (present/departed/conflicting/unobserved) with bookmarkable filters and bounded CSV parts.
- **Office Cases & Returns:** durable reasons, responsibility, watches, exact-unit dispositions and expected-return gaps. Original/replacement units and physical completion remain distinct. Imports and authorized visible Home/Office pages resume bounded evaluation with source/day/deadline freshness and saved progress. Read-only staff see incomplete/stale counts honestly. Manual office statements are explicitly not a qualified DMP adapter.
- **Dispatch & Lane Verification:** reviewed manual/workbook demand, exact-unit quantity allocation, native Pick Waves, actual lane scans, wrong-lane moves, preserved signoffs and targeted amendments. The UI exposes source qualification. Official DMP finals equivalence remains pending upstream evidence.
- **Labels:** retained printers/direct/laptop relay modes plus versioned label workflows/rules, issuance receipts, explicit reprints and separate physical confirmation. Browser/network acceptance never proves physical output; uncertain effects are not replayed automatically.
- **MARS, Scan Lists and Route Recon:** useful imports, scans, printable views and exports remain available. Report Engine remains marked legacy until replacements and owner acceptance justify retirement; no stored pipelines/files are deleted.

## DMP relay and payload administration

The owner confirms the existing DMP integration works well in real use. Preserve its signed-in external-page execution, per-user pairing, session leases, named server operations, request correlation/concurrency and no cookie export. [Relay setup](scripts/api-relay/README.md) describes the existing configured identity/delivery operations.

Admins manage named bookmarklet payloads at `/admin/payloads`: mobile source editing/import/export, drafts, immutable versions, preview, explicit publication/rollback, origin/protocol/operation constraints and stable payload-ID loaders. Preview has no external account authority. Payload changes do not replace or replay an in-flight mutation.

New DMP operations require a stable intent ID. Durable receipts survive lost responses; matching uncertain mutations block a fresh-ID retry until an authorized evidence-based reconciliation. Raw responses are not copied into public repository fixtures. Exact DMP unit/attempt/line mappings and MARS creation contracts must be qualified before those adapters are enabled.

## MCP

UI and authenticated MCP use the same explicit application action registry, domain validation, current capability/scope checks, attribution and effect receipts. MCP access never derives from possession of a database URL or an environment-selected user.

- Development stdio: `npm run --silent mcp`, using a short-lived user/session-bound `TEMCO_MCP_TOKEN` issued through **Your Connected Clients**.
- Remote HTTP: `npm run mcp:http`, using SDK OAuth discovery, S256 PKCE, exact resource binding and phone consent. See [MCP runbook](docs/v2/mcp-runbook.md).
- `application_actions` lists current actions; `application_action` invokes a shared command/query. Credential/authenticator ceremonies hand off to the authenticated person. Device-bound work still needs the actual authorized connected device; the server has no implied camera or LAN printer.

## Validation and launch

Run checks appropriate to a change, following each integration test's explicit dedicated-database guard. `npm run test:v2`, `npm run test:api-relay`, `npm run test:relay` and `npm run test:favorites` cover focused source behavior. Integration, migration, HTTP and phone-viewport evidence is recorded in [build status](docs/v2/build-status.md), with precise source/upstream/device limits.

The Docker/Compose/Caddy files are launch candidates. Use the [cutover runbook](docs/v2/cutover-runbook.md) and [MCP runbook](docs/v2/mcp-runbook.md); do not use the old main-branch deploy command for this build. Preparing or testing these files does not deploy v2, move main/v1, provision email/DNS, authorize live MARS submissions or establish operator acceptance.
