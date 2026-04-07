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
| `npx prisma studio` | Open Prisma database GUI |
| `npx prisma migrate dev` | Run pending migrations (dev) |
| `npx prisma migrate deploy` | Run pending migrations (prod) |

## Docker Deployment

To rebuild and redeploy after pulling new changes:

1. **Rebuild the image**:
   ```bash
   docker compose build
   ```

2. **Restart the services**:
   ```bash
   docker compose up -d
   ```

3. **Apply database migrations** (if any):
   ```bash
   docker compose exec app npx prisma migrate deploy
   ```

4. **Bootstrap admin user** (if first time or needed, requires `BOOTSTRAP_ADMIN_*` environment variables):
   ```bash
   docker compose exec app npx tsx scripts/bootstrap-admin.ts
   ```

## Manual Deployment

1. Set all environment variables on your hosting platform (`DATABASE_URL`, `SESSION_SECRET`).
2. Run `npx prisma migrate deploy` as part of your deployment pipeline.
3. Run `npm run bootstrap` once to create the initial admin user.
4. Build with `npm run build`.

## Troubleshooting

### Printing fails or the browser shows a network error

The MARS Label tool sends ZPL data directly to the Zebra printer at `10.108.40.114` over the local network. If printing fails:

1. **Allow mixed-content / local network access** – When the browser prompts you to allow communication with the printer's local IP address (e.g. `10.108.40.114`), click **Allow**. Some browsers block requests to private IP addresses from HTTPS pages by default.
2. **Check the printer endpoint** – In the MARS Label tool settings, confirm the printer endpoint matches the actual printer address and port (e.g. `http://10.108.40.114:9100`).
3. **Verify network connectivity** – Ensure your device is on the same local network as the printer.

### The app fails to start / database connection errors

Ensure the `db` service is fully healthy before the `app` container initialises. The `docker-compose.yml` uses a healthcheck on the `db` service so that `app` waits until PostgreSQL is ready.

## License

See [LICENSE](./LICENSE).

