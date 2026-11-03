import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { Prisma, type PrismaClient } from "@prisma/client";
import { SITE_TABLES } from "../lib/sites/tables";
import { decryptMfaSecret } from "../lib/auth/mfa-crypto";
import { hasColumn, inventoryRepairCounts, maintenanceClient, maintenanceFailure, maintenanceTarget, migrationState, printMaintenance, tableExists, MaintenanceError } from "./v2-preflight-support";

export async function inspectV2Readiness(prisma: PrismaClient, phase: "migrate" | "launch" = "migrate") {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    const migrations = await migrationState(tx);
    const strongHashPattern = "^scrypt-v2\\$[A-Za-z0-9_-]{22}\\$[A-Za-z0-9_-]{86}$";
    const blockers: string[] = [], warnings: string[] = [];
    if (migrations.failed.length) blockers.push("An unfinished migration requires investigation; do not mark it applied blindly.");
    if (migrations.checksumMismatch.length || migrations.unknownApplied.length) blockers.push("Applied migration history differs from this checkout.");
    if (migrations.pending.length && phase === "launch") blockers.push("Apply the reviewed pending migrations before launch.");
    let warehouseRuntime = null;
    if (await tableExists(tx, "WarehouseSite")) {
      const roles = await tx.$queryRaw<Array<{ restricted: boolean }>>`SELECT NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AS restricted FROM pg_roles WHERE rolname='temco_runtime'`;
      const tables = await tx.$queryRaw<Array<{name:string; forced:boolean}>>`SELECT c.relname AS name,c.relrowsecurity AND c.relforcerowsecurity AS forced FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'`;
      const missingOrUnscopedTables = SITE_TABLES.filter(name => !tables.some(table => table.name === name && table.forced));
      const functions = await tx.$queryRaw<Array<{name:string; securityDefiner:boolean; privilegedOwner:boolean; fixedSearchPath:boolean}>>`SELECT p.proname AS name,p.prosecdef AS "securityDefiner",r.rolsuper OR r.rolbypassrls AS "privilegedOwner",coalesce(array_to_string(p.proconfig,','),'') LIKE '%search_path=%' AS "fixedSearchPath" FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='public' AND p.proname IN ('temco_site_authorized','temco_integration_report','temco_printer_destination_busy','temco_platform_template_writer')`;
      const invalidFunctions = ["temco_site_authorized","temco_integration_report","temco_printer_destination_busy","temco_platform_template_writer"].filter(name => !functions.some(fn => fn.name === name && fn.securityDefiner && fn.privilegedOwner && fn.fixedSearchPath));
      warehouseRuntime = { restrictedRuntimeRole: roles[0]?.restricted === true, forcedOperationalTables: SITE_TABLES.length - missingOrUnscopedTables.length, expectedOperationalTables: SITE_TABLES.length, missingOrUnscopedTables, boundedSecurityDefinerFunctionsReady: invalidFunctions.length === 0, invalidFunctions };
      if (!warehouseRuntime.restrictedRuntimeRole) blockers.push("The operational runtime role must not bypass row security or administer database roles.");
      if (missingOrUnscopedTables.length || invalidFunctions.length) (phase === "launch" ? blockers : warnings).push("Apply/repair the reviewed warehouse row-security and bounded report/coordination function ownership before admission; do not widen the ordinary runtime role.");
    }
    let identity = null;
    if (await hasColumn(tx, "User", "passwordHash") && await tableExists(tx, "UserMfa") && await tableExists(tx, "RoleBundle")) {
      const warehouseRoles = await tableExists(tx, "WarehouseMembership");
      const capExpression = warehouseRoles ? Prisma.sql`coalesce((SELECT array_agg(DISTINCT cap) FROM "WarehouseMembership" wm JOIN "WarehouseSite" ws ON ws.id=wm."siteId" JOIN "WarehouseMembershipRole" mr ON mr."membershipId"=wm.id JOIN "WarehouseRole" r ON r.id=mr."roleId" CROSS JOIN unnest(r.capabilities) cap WHERE wm."userId"=u.id AND wm."isActive" AND ws."isActive" AND r."isActive" AND (r."siteId" IS NULL OR r."siteId"=wm."siteId")),ARRAY[]::text[])` : Prisma.sql`coalesce((SELECT array_agg(DISTINCT cap) FROM "UserRoleBundle" a JOIN "RoleBundle" b ON b.id=a."bundleId" CROSS JOIN unnest(b.capabilities) cap WHERE a."userId"=u.id),ARRAY[]::text[])`;
      const [counts] = await tx.$queryRaw<Record<string, bigint>[]>`
        WITH accounts AS (SELECT u.*,m."enabledAt" AS "mfaEnabledAt",${capExpression} AS caps,coalesce((to_jsonb(u)->>'isPlatformAdmin')::boolean,u.role='admin') AS platform FROM "User" u LEFT JOIN "UserMfa" m ON m."userId"=u.id)
        SELECT count(*) FILTER(WHERE "isActive") AS "activeUsers",
          count(*) FILTER(WHERE "isActive" AND "passwordHash" IS NULL) AS "activeUsersNeedingEnrollment",
          count(*) FILTER(WHERE "isActive" AND "passwordHash" IS NOT NULL AND "passwordHash" !~ ${strongHashPattern}) AS "unsupportedCredentials",
          count(*) FILTER(WHERE "isActive" AND (platform OR caps && ARRAY['users.manage','payloads.manage','labels.manage','office.decide','office.authorize_rtv','dispatch.allocate','dispatch.signoff','inventory.identify']) AND "mfaEnabledAt" IS NULL) AS "privilegedUsersNeedingMfa",
          count(*) FILTER(WHERE "isActive" AND platform AND "passwordHash" IS NOT NULL AND "mfaEnabledAt" IS NOT NULL) AS "readyRecoveryAdministrators",
          count(*) FILTER(WHERE "isActive" AND cardinality(caps)=0) AS "activeUsersWithoutWarehouseBundles"
        FROM accounts`;
      identity = Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value)]));
      // A restored enabled flag alone does not establish a usable recovery
      // administrator. Verify envelope/key compatibility without emitting any
      // account, ciphertext, secret or live authenticator code.
      const factors = await tx.$queryRaw<{ userId: string; encryptedSecret: string; recoveryAdministrator: boolean }[]>`
        SELECT m."userId",m."encryptedSecret",
          (coalesce((to_jsonb(u)->>'isPlatformAdmin')::boolean,u.role='admin') AND u."passwordHash" IS NOT NULL) AS "recoveryAdministrator"
        FROM "UserMfa" m JOIN "User" u ON u.id=m."userId"
        WHERE u."isActive" AND m."enabledAt" IS NOT NULL`;
      identity.unreadableEnabledMfaFactors = 0;
      for (const factor of factors) {
        try { decryptMfaSecret(factor.userId, factor.encryptedSecret); }
        catch {
          identity.unreadableEnabledMfaFactors++;
          if (factor.recoveryAdministrator) identity.readyRecoveryAdministrators--;
        }
      }
      if (identity.unreadableEnabledMfaFactors) (phase === "launch" ? blockers : warnings).push("Active authenticators cannot be decrypted with this runtime configuration. Restore the preserved MFA key or complete the authorized recovery procedure before opening admission.");
      if (identity.activeUsersNeedingEnrollment) (phase === "launch" ? blockers : warnings).push("Active legacy accounts require individual enrollment, or deliberate deactivation before launch; public PIN login is disabled.");
      if (identity.unsupportedCredentials) blockers.push("Unsupported strong credential format requires recovery; do not fall back to PIN.");
      if (identity.privilegedUsersNeedingMfa) (phase === "launch" ? blockers : warnings).push("Privileged accounts need authenticator enrollment; ordinary floor login is not forced to adopt MFA.");
      if (!identity.readyRecoveryAdministrators) (phase === "launch" ? blockers : warnings).push("Establish at least one enrolled active system administrator with users.manage and working MFA/recovery custody.");
    } else if (phase === "launch") blockers.push("Strong identity schema is not installed.");
    let inventory = null;
    if (await hasColumn(tx, "InventoryAuditItem", "unitId") && await tableExists(tx, "InventorySourceRevision")) {
      inventory = await inventoryRepairCounts(tx);
      if (inventory.missingUnits || inventory.missingCurrentRevisions || inventory.missingAliases) (phase === "launch" ? blockers : warnings).push("Inspect inventory structural gaps with the dry-run backfill tool.");
      if (inventory.conflictingCurrentRevisions) blockers.push("A retained immutable current source revision conflicts with its source row. Investigate without overwriting history.");
      if (inventory.conflictingAliases || inventory.duplicateNormalizedLpns || inventory.noncanonicalLpns) warnings.push("Identifier conflicts/noncanonical LPNs require bounded identity review; maintenance does not merge or normalize units.");
    } else if (phase === "launch") blockers.push("Shared warehouse identity schema is not installed.");
    const labelStates = await tableExists(tx, "LabelIssuance") ? await tx.$queryRaw<{ state: string; count: bigint }[]>`SELECT state,count(*) FROM "LabelIssuance" GROUP BY state ORDER BY state` : [];
    const dmpStates = await tableExists(tx, "DmpOperation") ? await tx.$queryRaw<{ state: string; count: bigint }[]>`SELECT state,count(*) FROM "DmpOperation" GROUP BY state ORDER BY state` : [];
    const marsStates = await tableExists(tx, "MarsSubmissionIntent") ? await tx.$queryRaw<{ state: string; count: bigint }[]>`SELECT state,count(*) FROM "MarsSubmissionIntent" GROUP BY state ORDER BY state` : [];
    if (labelStates.some((row) => ["queued", "dispatching"].includes(row.state) && row.count > BigInt(0))) (phase === "launch" ? blockers : warnings).push("Drain or explicitly reconcile pending durable label jobs before the cutover snapshot; never replay uncertain dispatch.");
    if (labelStates.some((row) => ["unknown", "sent_unconfirmed"].includes(row.state) && row.count > BigInt(0))) warnings.push("Retain and review uncertain/unconfirmed label receipts. A network send is not physical output.");
    if (dmpStates.some(row => row.state === "dispatching" && row.count > BigInt(0))) (phase === "launch" ? blockers : warnings).push("Resolve durable in-flight DMP intents before the cutover snapshot; no automatic replay.");
    if (dmpStates.some(row => row.state === "unknown" && row.count > BigInt(0))) warnings.push("Preserve uncertain DMP intents and reconcile upstream separately; a restored database must not replay them.");
    if (marsStates.some(row => row.state === "in_progress" && row.count > BigInt(0))) (phase === "launch" ? blockers : warnings).push("Reconcile in-progress human MARS handoffs before the cutover snapshot; local intent state is not proof of upstream completion.");
    if (marsStates.some(row => row.state === "unknown" && row.count > BigInt(0))) warnings.push("Preserve uncertain MARS intents and their original evidence; inspect the external outcome without automatically resubmitting.");
    return { phase, migrations, warehouseRuntime, identity, inventory, labelStates, dmpStates, marsStates, blockers, warnings, limits: ["Aggregate database inspection does not establish live relay quiescence, operator/device acceptance, upstream mapping, backup restoration, secret custody or production authorization.", "No source rows, identifiers, customer data, tokens, hashes or connection URLs are emitted."] };
  }, { isolationLevel: "RepeatableRead", timeout: 60_000 });
}

export async function runPreflightCli() {
  const { values } = parseArgs({ options: { "expect-database": { type: "string" }, "allow-operational-target": { type: "boolean", default: false }, phase: { type: "string", default: "migrate" } }, strict: true });
  if (values.phase !== "migrate" && values.phase !== "launch") throw new MaintenanceError("--phase must be migrate or launch.");
  const target = maintenanceTarget(values["expect-database"], values["allow-operational-target"]);
  const prisma = maintenanceClient(target);
  try {
    const report = await inspectV2Readiness(prisma, values.phase);
    let source = { head: "unavailable", branch: "unavailable", dirty: true };
    try { source = { head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), branch: execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim(), dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) }; } catch { /* Report incomplete source context, without dumping git stderr. */ }
    printMaintenance({ database: target.database, operationalTarget: target.operational, source, ...report });
    if (report.blockers.length) process.exitCode = 2;
  } finally { await prisma.$disconnect(); }
}
if (process.argv[1]?.endsWith("v2-preflight.ts")) runPreflightCli().catch(maintenanceFailure);
