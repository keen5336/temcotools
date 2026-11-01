import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { dirname, isAbsolute, relative } from "node:path";
import { parseArgs } from "node:util";
import type { PrismaClient } from "@prisma/client";
import { maintenanceClient, maintenanceFailure, maintenanceReason, maintenanceTarget, printMaintenance, MaintenanceError } from "./v2-preflight-support";

async function reserveDeliveryFile(filename?: string) {
  if (!filename || !isAbsolute(filename)) throw new MaintenanceError("--delivery-file must be an absolute new path in a private directory outside the checkout.");
  const parent = await realpath(dirname(filename)), repository = await realpath(process.cwd());
  const pathFromRepo = relative(repository, parent);
  if (!pathFromRepo.startsWith("..") && !isAbsolute(pathFromRepo)) throw new MaintenanceError("Enrollment material must be written outside the repository.");
  const directory = await stat(parent);
  if (!directory.isDirectory() || (directory.mode & 0o077) !== 0 || directory.uid !== process.getuid?.()) throw new MaintenanceError("The delivery directory must be owned by the current operator and mode 0700.");
  try { return await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch { throw new MaintenanceError("The delivery file must be new, non-symlink and writable; an existing file is never overwritten."); }
}

export async function bootstrapV2Administrator(prisma: PrismaClient, options: { username: string; displayName?: string; create: boolean; enrollExisting: boolean; recoverEnrolledAdmin?: boolean; apply: boolean; reason?: string; deliveryFile?: string }) {
  const username = options.username?.trim(), displayName = options.displayName?.trim();
  if (!username || username.length > 80 || /[\x00-\x1f\x7f]/.test(username)) throw new MaintenanceError("Supply --username with the exact intended account name.");
  if ([options.create, options.enrollExisting, options.recoverEnrolledAdmin].filter(Boolean).length !== 1) throw new MaintenanceError("Choose exactly one of --create, --enroll-existing or --recover-enrolled-admin.");
  if (options.create && (!displayName || displayName.length > 120 || /[\x00-\x1f\x7f]/.test(displayName))) throw new MaintenanceError("A new administrator needs --display-name (1 to 120 characters).");
  if (options.apply) maintenanceReason(options.reason);
  const delivery = options.apply ? await reserveDeliveryFile(options.deliveryFile) : null;
  const purpose = options.recoverEnrolledAdmin ? "reset" : "enroll";
  const token = `${purpose}_${randomBytes(32).toString("base64url")}`;
  try {
    return await prisma.$transaction(async (tx) => {
      if (!options.apply) await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      else await tx.$executeRaw`SELECT pg_advisory_xact_lock(8110102)`;
      const existing = await tx.user.findUnique({ where: { username }, select: { id: true, role: true, isActive: true, passwordHash: true, authVersion: true, roleBundles: { select: { bundle: { select: { capabilities: true } } } } } });
      if (existing && options.create) throw new MaintenanceError("That account already exists. No account or credential was replaced.");
      if (!existing && !options.create) throw new MaintenanceError("The exact administrator was not found. No account was created.");
      if (existing && (existing.role !== "admin" || !existing.isActive)) throw new MaintenanceError("Offline enrollment/recovery permits only an existing active administrator; it does not promote or reactivate accounts.");
      if (options.recoverEnrolledAdmin) {
        const interruptedRecovery = existing && !existing.passwordHash && await tx.identityAudit.count({ where: { targetUserId: existing.id, action: "offline_administrator_recovery_issued" } }) > 0;
        if ((!existing?.passwordHash && !interruptedRecovery) || !existing?.roleBundles.some(({ bundle }) => bundle.capabilities.includes("users.manage"))) throw new MaintenanceError("Emergency recovery requires an enrolled active administrator already assigned users.manage, or its recorded interrupted offline recovery. Existing access is not broadened.");
      } else {
        if (existing?.passwordHash) throw new MaintenanceError("This administrator is enrolled. Use authenticated recovery, or the separate explicit emergency recovery mode.");
        if (await tx.user.count({ where: { isActive: true, role: "admin", passwordHash: { not: null } } })) throw new MaintenanceError("An enrolled active administrator already exists. Use its authenticated user-management/recovery flow; initial bootstrap does not bypass it.");
      }
      if (!await tx.roleBundle.findUnique({ where: { id: "legacy-admin" }, select: { id: true } })) throw new MaintenanceError("Apply the strong identity migration and system administrator bundle first.");
      if (!options.apply) return { mode: "dry-run", action: options.recoverEnrolledAdmin ? "recover-enrolled-administrator-and-reset-factors" : existing ? "enroll-existing-administrator" : "create-initial-administrator", writes: 0, deliveryRequired: true };
      const user = existing ?? await tx.user.create({ data: { username, displayName: displayName!, pinHash: "disabled:v2", role: "admin", roleBundles: { create: { bundleId: "legacy-admin" } } } });
      const at = new Date(), expiresAt = new Date(at.getTime() + 30 * 60_000);
      if (existing) {
        await tx.user.update({ where: { id: user.id }, data: { authVersion: { increment: 1 }, ...(options.recoverEnrolledAdmin ? { passwordHash: null, passwordChangedAt: null } : {}) } });
        if (!options.recoverEnrolledAdmin) await tx.userRoleBundle.upsert({ where: { userId_bundleId: { userId: user.id, bundleId: "legacy-admin" } }, create: { userId: user.id, bundleId: "legacy-admin" }, update: {} });
      }
      await tx.userSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: at } });
      await tx.identityRecoveryToken.updateMany({ where: { userId: user.id, consumedAt: null }, data: { consumedAt: at } });
      if (options.recoverEnrolledAdmin) {
        await tx.appAccessGrant.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: at } });
        await tx.oAuthGrant.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: at, revokedReason: "Owner-assisted offline administrator recovery." } });
        await tx.printingDevice.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: at } });
        await tx.mfaRecoveryCode.updateMany({ where: { userId: user.id, consumedAt: null }, data: { consumedAt: at } });
        // Preserve the encrypted previous secret until new enrollment replaces
        // it; it is disabled, never exposed or used to authenticate recovery.
        await tx.userMfa.updateMany({ where: { userId: user.id }, data: { enabledAt: null, pendingExpiresAt: at, enrollmentSessionId: "offline-owner-recovery" } });
      }
      await tx.identityRecoveryToken.create({ data: { userId: user.id, tokenHash: createHash("sha256").update(token).digest("hex"), purpose, authVersion: user.authVersion + (existing ? 1 : 0), expiresAt } });
      await tx.identityAudit.create({ data: { action: options.recoverEnrolledAdmin ? "offline_administrator_recovery_issued" : existing ? "offline_initial_enrollment_issued" : "offline_initial_administrator_created", targetUserId: user.id, reason: `Owner-assisted offline maintenance: ${options.reason}` } });
      // Fsync before COMMIT. Failed/ambiguous runs retain a private delivery
      // file for investigation, never an automatically replayed setup code.
      await delivery!.writeFile(`${token}\n`); await delivery!.sync();
      return { mode: "applied", action: options.recoverEnrolledAdmin ? "administrator-recovery-issued-access-revoked-factors-disabled" : existing ? "enrollment-issued-existing-id-preserved" : "initial-administrator-created", expiresAt: expiresAt.toISOString(), privateDeliveryFileWritten: true, next: "Deliver the one-use code privately. The person sets their own strong password on /signin/recovery, signs in, then enrolls MFA and saves recovery codes at /account/security. No email was sent." };
    }, { isolationLevel: "Serializable", timeout: 30_000 });
  } finally { await delivery?.close(); }
}

export async function runBootstrapCli() {
  const { values } = parseArgs({ options: { "expect-database": { type: "string" }, "allow-operational-target": { type: "boolean", default: false }, username: { type: "string" }, "display-name": { type: "string" }, create: { type: "boolean", default: false }, "enroll-existing": { type: "boolean", default: false }, "recover-enrolled-admin": { type: "boolean", default: false }, apply: { type: "boolean", default: false }, reason: { type: "string" }, "delivery-file": { type: "string" } }, strict: true });
  const target = maintenanceTarget(values["expect-database"], values["allow-operational-target"]);
  const prisma = maintenanceClient(target);
  try { printMaintenance({ database: target.database, operationalTarget: target.operational, ...await bootstrapV2Administrator(prisma, { username: values.username ?? "", displayName: values["display-name"], create: values.create, enrollExisting: values["enroll-existing"], recoverEnrolledAdmin: values["recover-enrolled-admin"], apply: values.apply, reason: values.reason, deliveryFile: values["delivery-file"] }) }); }
  finally { await prisma.$disconnect(); }
}
if (process.argv[1]?.endsWith("v2-bootstrap.ts")) runBootstrapCli().catch(maintenanceFailure);
