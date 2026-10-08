# TemcoTools

Internal warehouse operations web app for Temco, built with Next.js, TypeScript, Tailwind CSS, Prisma ORM, and a PIN-based authentication system.

## Tech Stack

- **Framework**: Next.js (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **Database ORM**: Prisma
- **Database**: PostgreSQL
- **Authentication**: Internal PIN-based auth (iron-session + bcryptjs)

## Prerequisites

- Node.js 18+
- PostgreSQL 14+

## Getting Started

### 1. Clone and install

```bash
git clone <repo-url>
cd temcotools
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your actual values:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Random secret for encrypting session cookies — generate with `openssl rand -base64 32` (must be ≥ 32 chars) |
| `BOOTSTRAP_ADMIN_USERNAME` | Username for the initial admin account |
| `BOOTSTRAP_ADMIN_DISPLAY_NAME` | Display name shown in the UI for the initial admin |
| `BOOTSTRAP_ADMIN_PIN` | 4–6 digit PIN for the initial admin (will be hashed before storing) |

### 3. Set up the database

Create the PostgreSQL user and database (run as the `postgres` superuser):

```sql
CREATE USER ops_tools WITH PASSWORD 'your-secure-password';
CREATE DATABASE ops_tools OWNER ops_tools;
GRANT ALL PRIVILEGES ON DATABASE ops_tools TO ops_tools;
```

Then set `DATABASE_URL` in `.env`:

```
DATABASE_URL=postgresql://ops_tools:your-secure-password@localhost:5432/ops_tools
```

Apply migrations and generate the Prisma client:

```bash
npx prisma migrate deploy
npx prisma generate
```

### 4. Create the first admin user

Run the bootstrap script once after the initial migration:

```bash
npm run bootstrap
```

This reads `BOOTSTRAP_ADMIN_USERNAME`, `BOOTSTRAP_ADMIN_DISPLAY_NAME`, and `BOOTSTRAP_ADMIN_PIN` from your `.env` file, hashes the PIN, and creates the admin user. It is safe to run multiple times — it will skip creation if the username already exists.

### 5. Run the development server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and sign in with the username and PIN you configured.

## Project Structure

```
├── app/
│   ├── (auth)/
│   │   └── signin/               # PIN login page (public)
│   ├── admin/
│   │   └── users/                # User management (admin only)
│   ├── tools/
│   │   ├── rtv-label/            # MARS label generation and printing tool
│   │   ├── barcode-generator/    # Batch barcode generation and printing tool
│   │   └── report-engine/        # CSV pipeline / report builder tool
│   ├── api/
│   │   ├── auth/
│   │   │   ├── login/            # POST — validates username + PIN, sets session cookie
│   │   │   └── logout/           # POST — destroys session cookie
│   │   └── admin/users/          # Admin user management API
│   ├── layout.tsx
│   └── page.tsx                  # Home dashboard
├── components/                   # Reusable React components
├── lib/
│   ├── auth/                     # requireAuth() and requireAdmin() server helpers
│   ├── db/                       # Prisma client singleton
│   └── session.ts                # iron-session config and SessionData type
├── scripts/
│   └── bootstrap-admin.ts        # First-run admin creation script
├── prisma/
│   ├── schema.prisma             # Database schema
│   └── migrations/               # Migration history
```

## Authentication & Authorization

- Users log in with a **username** and a **4–6 digit PIN**.
- PINs are hashed with bcrypt before being stored; plaintext PINs are never persisted.
- Sessions are stored in encrypted httpOnly cookies (via iron-session).
- `requireAuth()` — redirects unauthenticated or inactive users to `/signin`.
- `requireAdmin()` — additionally redirects non-admin users to `/`.
- Admins manage users at `/admin/users`: create, edit, set/reset PIN, change role, activate/deactivate.
- Deactivated accounts cannot log in.

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server |
| `npm run build` | Build for production |
| `npm run start` | Start production server |
| `npm run lint` | Run ESLint |
| `npm run bootstrap` | Create initial admin user (run once after first migration) |
| `npm run --silent mcp` | Start the TemcoTools MCP server over stdio |
| `npm run relay` | Start the label relay WebSocket service (port 3002) |
| `npm run test:relay` | Test relay authentication, routing, queuing, and failures |
| `npx prisma studio` | Open Prisma database GUI |
| `npx prisma migrate dev` | Run pending migrations (dev) |
| `npx prisma migrate deploy` | Run pending migrations (prod) |

## MCP Server

TemcoTools includes a read-only MCP server for MARS workflow inspection. It uses the same
`DATABASE_URL` as the web app and exposes tools for workflow summaries, unit search, unit detail,
problem units, and status-rule explanation.

For MCP client configuration on a local checkout, prefer launching the binary directly so stdio
stays protocol-clean:

```bash
./node_modules/.bin/tsx scripts/mcp-server.ts
```

On the VPS, launch the stdio MCP server as its own Docker Compose service:

```bash
cd /srv/temcotools
docker compose run --rm -T mcp
```

For an MCP client that connects over SSH, use that command as the remote stdio process. The MCP
container joins the internal Compose network and talks to Postgres through the private `db` service.

The initial tool set is intentionally read-only. Local bucket override and problem-resolution tools
should be added after the database has explicit fields for Temco-side resolutions.

## Docker Deployment

On the VPS, pull the published main branch and run the deployment script:

```bash
cd /srv/temcotools
git pull --ff-only
./scripts/deploy.sh
```

The script requires a clean main checkout matching `origin/main`. It builds the
app and a separate migration image using the locked Prisma version, applies
pending migrations, and then restarts the app and label relay with health checks.
The existing database service stays running. To apply migrations separately:

```bash
docker compose build migrate
docker compose run --rm --no-deps -T migrate
```

Bootstrap the first administrator once using `scripts/bootstrap-admin.ts` with
`BOOTSTRAP_ADMIN_*` environment variables, as described above.

## Manual Deployment

1. Set all environment variables on your hosting platform (`DATABASE_URL`, `SESSION_SECRET`).
2. Run `npx prisma migrate deploy` as part of your deployment pipeline.
3. Run `npm run bootstrap` once to create the initial admin user.
4. Build with `npm run build`.

## Pick Wave Actions

In **Pick Items**, select a row and choose **Print pick label**. Printing uses the
selected printer, template, relay preference, and saved route staging location.
It does not mark the item picked or add a scan. Enable **Show scanned** to reprint
a picked item. An item needs a saved staging location before it can print.

Under **Recent Scans**, choose **Save to scan list** to save the wave's complete
scan history, including entries older than the 25-row preview. The saved list
preserves duplicate and unmatched values, scan times, and scanner attribution.
The confirmation links to the list in Scan Lists, where CSV export is available.
Saving unchanged history reuses the same list; new scans produce a new snapshot.
Existing local scan-list drafts are unaffected.

## Inventory Audit

Open **Inventory Audit** from Operations Tools, upload the same `.xlsx` or `.xls`
LPN report used by **LPN Put Away**, then use **Export to Inventory Audit** under
Recent Scans in each Pick Wave. The report imports every status and received date.

The running inventory uses a case-insensitive LPN key and retains all imported
report columns. Reimporting identical data does not change the row, its scan
confirmation, or archive state. A change to any report field increases the revision,
restores an archived row to Active, and marks it Needs scan. LPNs absent from a later
report stay in the tracker. Archive/restore individual rows or select up to 100
rows per page; search and CSV export can include archived inventory.

Pick Wave exports retain the entire scan history, including duplicates, scanner
names, original scan times, and unmatched values. Serial/order/part scans use the
LPN of the matched picked item. Unmatched scans can match an exact LPN; matched
items without an LPN remain visible for review. Repeated exports add only new scan
events. Deleting a Pick Wave does not delete its audit evidence. Reports imported
after scans match previously unknown LPNs automatically on first appearance. After
a report change, only a new exported scan taken after that change confirms the
current revision; old scans stay visible as history.

Reports are imported atomically in batches, with a 100,000-row / 50 MB limit.
Identical duplicate LPN rows are collapsed; conflicting duplicates reject the
report so an arbitrary row cannot overwrite inventory. The inventory and unmatched
scan views are paginated, and inventory CSV exports include all rows matching the
selected filters, including each full source report row.

Run `npm run test:inventory-audit` for report validation tests. For database tests,
apply migrations to a disposable local database named `temcotools_audit_test` and
set `AUDIT_TEST_DATABASE_URL` to its connection URL. The integration suite refuses
other database names or nonlocal hosts.

## Troubleshooting

### Label Relay Mode

Use relay mode when a scanner cannot reach a label printer but a laptop can:

1. Sign in on the laptop and open **Relay Mode** in the header, beside your name.
2. Select the printers reachable from that laptop and turn on **Label Relay Mode**.
3. Keep TemcoTools open and the laptop awake. You can close the dropdown and navigate between tools; the relay stays connected. Its browser must allow the configured printer endpoints, just as for direct printing.
4. On the scanner's Pick Wave or MARS Label page, choose the printer and turn on **Use label relay**. This preference is shared across label pages and saved on that device.

The laptop's settings are also saved; reopening TemcoTools while signed in restores the enabled state.
The receiver lives in the shared app layout, so page navigation and dropdown visibility
do not interrupt it. Turning it off, signing out, or closing the tab disconnects it.
All signed-in users can use it. There is no separate relay page or home-page card.
Multiple laptops may serve a printer, but each label is sent to exactly one laptop.
Concurrent scans are queued (up to eight jobs per laptop) and delivered one at a time.
The scanner waits for the laptop's result. Failed or uncertain jobs are never retried
automatically: check physical output before retrying to avoid duplicate labels.
Browser requests use `no-cors`, so a completed request does not prove physical printing.

MARS bookmarklets generated with relay enabled open the extracted fields in TemcoTools
for review and printing. This keeps authentication on the TemcoTools origin. Existing
direct-print bookmarklets retain their original behavior until replaced.

The WebSocket service authenticates using the app's encrypted session cookie and
rechecks active users and managed printers through `/api/label-relay/session`.
Scanners submit a printer ID and ZPL, never a destination URL. Labels are transient
in memory; restarting the service does not replay outstanding jobs.

**Production:** `scripts/deploy.sh` builds the published clean `main` revision and restarts
both `app` and `label-relay`. Caddy must route `/api/label-relay/ws` to `127.0.0.1:3002`;
all other requests continue to port 3000. See `scripts/label-relay/Caddyfile.example`.
Update `RELAY_ORIGIN` in Compose if the app hostname changes. The relay port is bound
only to loopback, and Caddy supplies TLS and WebSocket upgrades. No database migration
is needed for this feature.

**Development:** run `npm run dev` and `npm run relay` in separate terminals. The browser
uses port 3002 for relay connections in development. Defaults expect the app at
`http://localhost:3000`; set `RELAY_ORIGIN` and `RELAY_APP_URL` for a different origin or port.

### Printing fails or the browser shows a network error

Label tools send ZPL to the selected managed printer over the local network, either from the current device or from the relay laptop. If printing fails:

1. **Allow mixed-content / local network access** – When the browser prompts you to allow communication with the printer's local IP address (e.g. `10.108.40.114`), click **Allow**. Some browsers block requests to private IP addresses from HTTPS pages by default.
2. **Check the printer endpoint** – In Label Configuration, confirm the managed printer endpoint matches the actual printer address and port (e.g. `http://10.108.40.114:9100`).
3. **Verify network connectivity** – Ensure your device is on the same local network as the printer.

### The app fails to start / database connection errors

Ensure the `db` service is fully healthy before the `app` container initialises. The `docker-compose.yml` uses a healthcheck on the `db` service so that `app` waits until PostgreSQL is ready.

## License

See [LICENSE](./LICENSE).
