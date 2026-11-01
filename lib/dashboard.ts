import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import type { Capability, Principal } from "@/lib/auth/principal";
import { businessDay } from "@/lib/office/domain";
import { getDispatchDashboardInTransaction } from "@/lib/dispatch/service";

export const WIDGETS = [
  { id: "priorities", name: "Office priorities", capability: "workflow.read", href: "/tools/office" },
  { id: "picks", name: "Pick work", capability: "workflow.read", href: "/tools/pick-waves" },
  { id: "dispatch", name: "Dispatch day progress", capability: "workflow.read", href: "/tools/dispatch" },
  { id: "observations", name: "Physical observations", capability: "inventory.read", href: "/tools/warehouse-scan" },
  { id: "sources", name: "Source freshness", capability: "inventory.read", href: "/tools/inventory-audit" },
  { id: "labels", name: "Label follow-up", capability: "labels.read", href: "/management/label-workflows" },
  { id: "access", name: "Enrollment readiness", capability: "users.manage", href: "/admin/users" },
] as const satisfies readonly { id: string; name: string; capability: Capability; href: string }[];
export type WidgetId = typeof WIDGETS[number]["id"];
const widgetSchema = z.enum(WIDGETS.map(widget => widget.id) as [WidgetId, ...WidgetId[]]);
export class DashboardError extends Error { constructor(message: string, readonly status = 409) { super(message); } }
export function authorizedWidgets(capabilities: readonly Capability[]) { return WIDGETS.filter(widget => capabilities.includes(widget.capability)); }
export function defaultWidgets(capabilities: readonly Capability[]) {
  const order: WidgetId[] = capabilities.includes("office.decide") ? ["priorities", "dispatch", "picks", "observations", "sources", "labels", "access"] : ["picks", "dispatch", "observations", "priorities", "sources", "labels", "access"];
  return order.filter(id => authorizedWidgets(capabilities).some(widget => widget.id === id));
}
export async function saveDashboardPreferences(principal: Principal, input: unknown) {
  const data = z.object({ widgetIds: z.array(widgetSchema).max(WIDGETS.length), expectedRevision: z.number().int().min(0), useDefaults: z.boolean().default(false) }).strict().parse(input);
  if (new Set(data.widgetIds).size !== data.widgetIds.length) throw new DashboardError("Choose each widget once.", 400);
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`dashboard:${principal.userId}`}, 0))`;
    const current = await assertCurrentPrincipal(tx, principal, "account.self");
    const allowed = new Set(authorizedWidgets(current.capabilities).map(widget => widget.id));
    if (data.widgetIds.some(id => !allowed.has(id))) throw new DashboardError("Your current permissions do not allow that widget.", 403);
    const previous = await tx.dashboardPreference.findUnique({ where: { userId: principal.userId } });
    if ((previous?.revision ?? 0) !== data.expectedRevision) throw new DashboardError("Your dashboard changed in another tab. Refresh before saving.");
    if (data.useDefaults) { await tx.dashboardPreference.deleteMany({ where: { userId: principal.userId } }); return { revision: 0, widgetIds: defaultWidgets(current.capabilities) }; }
    const saved = await tx.dashboardPreference.upsert({ where: { userId: principal.userId }, create: { userId: principal.userId, widgetIds: data.widgetIds }, update: { widgetIds: data.widgetIds, revision: { increment: 1 } } });
    return { revision: saved.revision, widgetIds: saved.widgetIds };
  });
}
export async function getOperationalDashboard(principal: Principal) {
  return prisma.$transaction(async tx => {
    const current = await assertCurrentPrincipal(tx, principal);
    const available = authorizedWidgets(current.capabilities);
    const preference = await tx.dashboardPreference.findUnique({ where: { userId: current.userId } });
    const selected = preference ? preference.widgetIds.filter(id => available.some(widget => widget.id === id)) : defaultWidgets(current.capabilities);
    const now = new Date(), zone = process.env.WAREHOUSE_TIME_ZONE || "America/Chicago", day = businessDay(now, zone);
    const widgets: { id: WidgetId; title: string; href: string; summary: string; lines: string[]; items?: { id: string; text: string; href: string }[] }[] = [];
    for (const id of selected) {
      const definition = available.find(widget => widget.id === id)!;
      if (id === "priorities") {
        const open = await tx.officeCase.count({ where: { status: { not: "resolved" } } });
        const due = await tx.officeCase.count({ where: { status: { not: "resolved" }, OR: [{ status: "open" }, { reviewAt: { lte: now } }] } });
        const cases = await tx.officeCase.findMany({ where: { status: { not: "resolved" } }, orderBy: [{ reviewAt: "asc" }, { updatedAt: "asc" }], take: 5, select: { id: true, reason: true, status: true, nextAction: true } });
        widgets.push({ id, title: definition.name, href: definition.href, summary: `${due} need review · ${open} active cases`, lines: ["Valid watch instructions stay durable. Refreshing this view does not reevaluate every unit."], items: cases.map(item => ({ id: item.id, text: `${item.status}: ${item.nextAction || item.reason.replaceAll("_", " ")}`, href: `/tools/office?caseId=${encodeURIComponent(item.id)}` })) });
      } else if (id === "picks") {
        const waves = await tx.pickWave.findMany({ where: { archivedAt: null }, orderBy: { updatedAt: "desc" }, take: 5, select: { id: true, name: true, _count: { select: { items: true } } } });
        const total = await tx.pickWaveItem.count({ where: { pickWave: { archivedAt: null } } });
        const confirmed = await tx.pickWaveItem.count({ where: { pickWave: { archivedAt: null }, scannedAt: { not: null } } });
        widgets.push({ id, title: definition.name, href: definition.href, summary: `${confirmed} / ${total} active pick rows scanned`, lines: ["Pick progress does not replace dispatch-day lane confirmation."], items: waves.map(wave => ({ id: wave.id, text: `${wave.name} · ${wave._count.items} rows`, href: `/tools/pick-waves/${wave.id}` })) });
      } else if (id === "dispatch") {
        const progress = await getDispatchDashboardInTransaction(tx, day);
        widgets.push({ id, title: definition.name, href: definition.href, summary: progress.scopes.some(scope => scope.unavailable) ? "Verification incomplete — scope data unavailable" : progress.scopes.length ? `${progress.scopes.reduce((sum, scope) => sum + scope.confirmed, 0)} / ${progress.scopes.reduce((sum, scope) => sum + scope.required, 0)} lane units confirmed` : "No accepted demand for today", lines: [progress.sourceNotice, `${progress.scopes.reduce((sum, scope) => sum + scope.signedLanes, 0)} current signed lanes · ${progress.scopes.reduce((sum, scope) => sum + scope.recheckLanes, 0)} need verification/recheck`, ...(progress.hasMore ? ["Showing five recent scopes. Open dispatch for all scopes."] : []), ...(progress.scopes.some(scope => scope.unavailable) ? ["Some accepted demand has no verification session; open dispatch to review it."] : [])], items: progress.scopes.map(scope => ({ id: scope.boardId, text: `${scope.scope}: ${scope.unavailable ? "verification unavailable" : `${scope.confirmed}/${scope.required} confirmed · ${scope.recheckLanes} lanes to review`}`, href: "/tools/dispatch" })) });
      } else if (id === "observations") {
        const [counts] = await tx.$queryRaw<{ count: number; unresolved: number }[]>`
          SELECT count(*)::int AS count, count(*) FILTER (WHERE CASE WHEN c.id IS NOT NULL THEN c."unitId" ELSE o."unitId" END IS NULL)::int AS unresolved
          FROM "WarehousePhysicalObservation" o LEFT JOIN LATERAL (SELECT id,"unitId" FROM "WarehouseObservationCorrection" WHERE "observationId"=o.id ORDER BY revision DESC LIMIT 1) c ON true
          WHERE to_char(o."capturedAt" AT TIME ZONE ${zone}, 'YYYY-MM-DD')=${day}`;
        widgets.push({ id, title: definition.name, href: current.capabilities.includes("inventory.write") ? definition.href : "/tools/warehouse", summary: `${counts.count} physical events today · ${counts.unresolved} need identity review`, lines: ["Counts are observations, including repeated evidence; they are not a count of current physical stock."] });
      } else if (id === "sources") {
        const report = await tx.inventoryAuditImport.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true, sourceAsOf: true, scope: true, coverage: true, rowCount: true } });
        const mars = current.capabilities.includes("workflow.read") ? await tx.marsImportBatch.findFirst({ orderBy: { uploadedAt: "desc" }, select: { uploadedAt: true } }) : null;
        widgets.push({ id, title: definition.name, href: definition.href, summary: report ? `WMS ${report.coverage} · ${report.rowCount} source rows` : "No shared WMS report imported", lines: [report ? `Source as of: ${report.sourceAsOf?.toISOString() || "not supplied"} · accepted: ${report.createdAt.toISOString()} · scope: ${report.scope}` : "Import one shared report for saved operational views.", ...(current.capabilities.includes("workflow.read") ? [mars ? `MARS last imported: ${mars.uploadedAt.toISOString()}` : "MARS has no imported snapshot."] : []), "DMP normalized synchronization is pending source mapping qualification; a connected relay alone is not a refreshed demand snapshot."] });
      } else if (id === "labels") {
        const uncertain = await tx.labelIssuance.count({ where: { state: { in: ["dispatching", "unknown"] } } });
        const queued = await tx.labelIssuance.count({ where: { state: "queued" } });
        const sent = await tx.labelIssuance.count({ where: { state: "sent_unconfirmed" } });
        widgets.push({ id, title: definition.name, href: current.capabilities.includes("labels.manage") ? definition.href : "/tools/warehouse", summary: `${uncertain} uncertain · ${queued} queued`, lines: [`${sent} sends await physical confirmation. Inspect the receipt/printer before an explicit reprint; unknown effects are never automatically replayed.`] });
      } else if (id === "access") {
        const unenrolled = await tx.user.count({ where: { isActive: true, passwordHash: null } });
        const noMfa = await tx.user.count({ where: { isActive: true, passwordHash: { not: null }, OR: [{ mfa: null }, { mfa: { enabledAt: null } }] } });
        widgets.push({ id, title: definition.name, href: definition.href, summary: `${unenrolled} active accounts need strong enrollment`, lines: [`${noMfa} enrolled accounts have no active authenticator. Sensitive administration requires current password and authenticator proof.`] });
      }
    }
    return { asOf: now.toISOString(), day, timeZone: zone, revision: preference?.revision ?? 0, selectedWidgetIds: selected, availableWidgets: available, widgets };
  }, { isolationLevel: "RepeatableRead", timeout: 15_000 });
}
export type OperationalDashboard = Awaited<ReturnType<typeof getOperationalDashboard>>;
