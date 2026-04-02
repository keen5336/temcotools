# TemcoTools

Internal warehouse operations web app for Temco, built with Next.js, TypeScript, Tailwind CSS, Prisma ORM, and NextAuth.js.

## Tech Stack

- **Framework**: Next.js 15 (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **Database ORM**: Prisma
- **Database**: PostgreSQL
- **Authentication**: NextAuth.js v5 with Microsoft Azure AD (Entra ID)

## Prerequisites

- Node.js 18+
- PostgreSQL 14+
- Azure AD (Microsoft Entra ID) app registration

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
| `NEXTAUTH_URL` | Your app's public URL (e.g., `http://localhost:3000`) |
| `NEXTAUTH_SECRET` | Random secret — generate with `openssl rand -base64 32` |
| `AZURE_AD_CLIENT_ID` | Azure AD app registration client ID |
| `AZURE_AD_CLIENT_SECRET` | Azure AD app registration client secret |
| `AZURE_AD_TENANT_ID` | Azure AD tenant ID |
| `FIRST_ADMIN_EMAIL` | Email of the first user who should receive the admin role |

### 3. Set up the database

```bash
npx prisma migrate deploy
npx prisma generate
```

### 4. Run the development server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Database Bootstrap

Before running the app for the first time, create the PostgreSQL user and database:

```sql
-- Run as the postgres superuser:
CREATE USER ops_tools WITH PASSWORD 'your-secure-password';
CREATE DATABASE ops_tools OWNER ops_tools;
GRANT ALL PRIVILEGES ON DATABASE ops_tools TO ops_tools;
```

Then set your `DATABASE_URL` in `.env`:

```
DATABASE_URL=postgresql://ops_tools:your-secure-password@localhost:5432/ops_tools
```

Apply migrations:

```bash
npx prisma migrate deploy
npx prisma generate
```

## Azure AD Setup

1. Go to [Azure Portal](https://portal.azure.com) → **Azure Active Directory** → **App registrations** → **New registration**
2. Set **Redirect URI** to: `http://localhost:3000/api/auth/callback/microsoft-entra-id` (Web platform)
3. Under **Certificates & secrets**, create a new client secret
4. Note the **Application (client) ID**, **Directory (tenant) ID**, and client secret value
5. Under **API permissions**, ensure `openid`, `profile`, and `email` are granted

## Project Structure

```
├── app/
│   ├── (auth)/
│   │   └── signin/           # Sign-in page (no auth required)
│   ├── admin/
│   │   └── users/            # User management (admin only)
│   ├── tools/
│   │   ├── rtv-label/        # RTV label generation tool
│   │   ├── receiving-reconcile/  # Receiving reconciliation tool
│   │   └── scanner-lookup/   # Barcode scanner lookup tool
│   ├── api/
│   │   ├── auth/[...nextauth]/   # NextAuth.js API handler
│   │   └── admin/users/      # Admin user management API
│   ├── layout.tsx
│   └── page.tsx              # Home dashboard
├── components/               # Reusable React components
├── lib/
│   ├── auth/                 # Auth helpers (requireAuth, requireAdmin)
│   └── db/                   # Prisma client singleton
├── prisma/
│   ├── schema.prisma         # Database schema
│   └── migrations/           # Migration history
├── types/
│   └── next-auth.d.ts        # NextAuth type extensions
└── auth.ts                   # NextAuth configuration
```

## Authentication & Authorization

- **No local passwords** — all authentication is via Microsoft Azure AD (Entra ID)
- First sign-in auto-provisions the user in the database
- The email in `FIRST_ADMIN_EMAIL` is granted admin role on first login
- Admins can promote/demote users and activate/deactivate accounts via `/admin/users`
- Deactivated accounts are blocked at sign-in

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server |
| `npm run build` | Build for production |
| `npm run start` | Start production server |
| `npm run lint` | Run ESLint |
| `npx prisma studio` | Open Prisma database GUI |
| `npx prisma migrate dev` | Run pending migrations (dev) |
| `npx prisma migrate deploy` | Run pending migrations (prod) |

## Deployment

1. Set all environment variables on your hosting platform
2. Run `npx prisma migrate deploy` as part of your deployment pipeline
3. Build with `npm run build`

## License

See [LICENSE](./LICENSE).
