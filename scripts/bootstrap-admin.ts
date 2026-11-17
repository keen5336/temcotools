/** Creates an unenrolled first administrator; use account-enrollment next. */
import "dotenv/config";
import { parseArgs } from "node:util";

async function main() {
  const { values } = parseArgs({ options: { "expect-host": { type: "string" }, "expect-database": { type: "string" }, apply: { type: "boolean", default: false } } });
  const username = process.env.BOOTSTRAP_ADMIN_USERNAME?.trim();
  const displayName = process.env.BOOTSTRAP_ADMIN_DISPLAY_NAME?.trim();
  const target = new URL(process.env.DATABASE_URL || "");
  if (!username || username.length > 80 || !displayName || displayName.length > 100 || !values["expect-host"] || !values["expect-database"] || target.host !== values["expect-host"] || decodeURIComponent(target.pathname.slice(1)) !== values["expect-database"]) throw new Error("Missing or mismatched bootstrap arguments.");
  const { prisma } = await import("../lib/db");
  try {
    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) {
      if (existing.role !== "admin" || !existing.isActive) throw new Error("Existing username is not an active administrator.");
      console.log("Active administrator already exists; unchanged. Use account-enrollment for setup/recovery."); return;
    }
    if (!values.apply) { console.log("Dry run: would create an unenrolled administrator. Add --apply to create it."); return; }
    await prisma.$transaction(async tx => {
      const { lockAuthWrites } = await import("../lib/auth/sessions"); await lockAuthWrites(tx);
      if (await tx.user.count({ where: { role: "admin", isActive: true } })) throw new Error("Bootstrap is only for a database without an active administrator.");
      await tx.user.create({ data: { username, displayName, pinHash: "disabled:enrollment", legacyDisabledAt: new Date(), role: "admin" } });
      await tx.authAudit.create({ data: { action: "operator_admin_created", reason: "First administrator bootstrap" } });
    });
    console.log("Unenrolled administrator created. Use account-enrollment to deliver a private setup code. No PIN or password was created.");
  } finally { await prisma.$disconnect(); }
}
main().catch(() => { console.error("Bootstrap did not confirm completion. Check target arguments and current account state before retrying. No credentials are printed."); process.exitCode = 1; });
