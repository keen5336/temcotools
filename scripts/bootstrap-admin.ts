/**
 * Strong-credential bootstrap. No public legacy PIN authentication is enabled.
 *
 * New administrator: BOOTSTRAP_ADMIN_USERNAME, BOOTSTRAP_ADMIN_DISPLAY_NAME,
 * BOOTSTRAP_ADMIN_PASSWORD (or BOOTSTRAP_ADMIN_PASSWORD_FILE), DATABASE_URL.
 * Existing active legacy administrator: also pass --enroll-existing.
 * Existing enrolled accounts are never overwritten. Use assisted recovery.
 * Run only against an explicitly selected authorized database after migrations.
 */
import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword, validatePassword } from "../lib/auth/passwords";

async function main() {
  const username = process.env.BOOTSTRAP_ADMIN_USERNAME?.trim();
  const displayName = process.env.BOOTSTRAP_ADMIN_DISPLAY_NAME?.trim();
  const passwordFile = process.env.BOOTSTRAP_ADMIN_PASSWORD_FILE;
  const password = passwordFile ? (await readFile(passwordFile, "utf8")).replace(/\r?\n$/, "") : process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!username || !displayName || !password || !process.env.DATABASE_URL) {
    throw new Error("Set DATABASE_URL, BOOTSTRAP_ADMIN_USERNAME, BOOTSTRAP_ADMIN_DISPLAY_NAME and a password or password file.");
  }
  validatePassword(password, username);
  const passwordHash = await hashPassword(password);
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(8110102)`;
      const existing = await tx.user.findUnique({ where: { username } });
      if (existing) {
        if (existing.passwordHash) return "Existing enrolled account preserved; no changes made.";
        if (!process.argv.includes("--enroll-existing")) return "Existing legacy account preserved. Use --enroll-existing to explicitly enroll this active administrator.";
        if (existing.role !== "admin" || !existing.isActive) throw new Error("Only an existing active administrator can use offline initial enrollment.");
        await tx.user.update({ where: { id: existing.id }, data: { passwordHash, passwordChangedAt: new Date(), authVersion: { increment: 1 } } });
        await tx.userRoleBundle.upsert({ where: { userId_bundleId: { userId: existing.id, bundleId: "legacy-admin" } }, create: { userId: existing.id, bundleId: "legacy-admin" }, update: {} });
        await tx.userSession.updateMany({ where: { userId: existing.id, revokedAt: null }, data: { revokedAt: new Date() } });
        await tx.identityAudit.create({ data: { action: "bootstrap_enrolled", targetUserId: existing.id, reason: "Explicit offline initial administrator credential enrollment." } });
        return "Existing administrator enrolled with strong credentials; prior sessions revoked. User ID and history preserved.";
      }
      const user = await tx.user.create({ data: { username, displayName, pinHash: "disabled:v2", passwordHash, passwordChangedAt: new Date(), role: "admin", roleBundles: { create: { bundleId: "legacy-admin" } } } });
      await tx.identityAudit.create({ data: { action: "bootstrap_created", targetUserId: user.id, reason: "Offline initial administrator bootstrap." } });
      return "Initial administrator created with strong credentials.";
    });
    console.log(result);
  } finally { await prisma.$disconnect(); }
}

main().catch(() => { console.error("Administrator bootstrap failed. Check the explicit target database, migration state and credential policy; no credentials are printed."); process.exitCode = 1; });
