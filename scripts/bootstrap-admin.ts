/**
 * Bootstrap script: creates the initial admin user if one does not already exist.
 *
 * Usage:
 *   npx tsx scripts/bootstrap-admin.ts
 *
 * Required environment variables:
 *   BOOTSTRAP_ADMIN_USERNAME     - username for the admin account
 *   BOOTSTRAP_ADMIN_DISPLAY_NAME - display name shown in the UI
 *   BOOTSTRAP_ADMIN_PIN          - 4-6 digit PIN (will be hashed before storing)
 *   DATABASE_URL                 - PostgreSQL connection string
 *
 * This script is idempotent: it will not recreate the user if the username
 * already exists. Run it once after the first database migration.
 */

try {
  require("dotenv/config");
} catch (e) {
  // Ignore missing dotenv in production
}
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";

async function main() {
  const username = process.env.BOOTSTRAP_ADMIN_USERNAME;
  const displayName = process.env.BOOTSTRAP_ADMIN_DISPLAY_NAME;
  const pin = process.env.BOOTSTRAP_ADMIN_PIN;

  if (!username || !displayName || !pin) {
    console.error(
      "Error: BOOTSTRAP_ADMIN_USERNAME, BOOTSTRAP_ADMIN_DISPLAY_NAME, and BOOTSTRAP_ADMIN_PIN must all be set."
    );
    process.exit(1);
  }

  if (!/^\d{4,6}$/.test(pin)) {
    console.error("Error: BOOTSTRAP_ADMIN_PIN must be 4 to 6 digits.");
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL!;
  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });

  try {
    const existing = await prisma.user.findUnique({ where: { username } });

    if (existing) {
      console.log(`Admin user "${username}" already exists — skipping.`);
      return;
    }

    const pinHash = await bcrypt.hash(pin, 12);

    await prisma.user.create({
      data: {
        username,
        displayName,
        pinHash,
        role: "admin",
        isActive: true,
      },
    });

    console.log(`Admin user "${username}" created successfully.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("Bootstrap failed:", err);
  process.exit(1);
});
