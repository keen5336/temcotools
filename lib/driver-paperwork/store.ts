import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { DEFAULT_TEMPLATES, saveSchema, templateSchema } from "./templates";
import { getDefaultProgram, validateProgram } from "./program";

export class PaperworkError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
const snapshot = (revision: { version: number; template: unknown; program: string; operationId: string; createdAt: Date } | null) => ({
  version: revision?.version ?? 0,
  template: templateSchema.parse(revision?.template ?? DEFAULT_TEMPLATES),
  program: revision?.program ?? getDefaultProgram(),
  operationId: revision?.operationId ?? null,
  createdAt: revision?.createdAt.toISOString() ?? null,
});
export async function getPublishedTemplate() {
  return snapshot(await prisma.driverPaperworkRevision.findFirst({ orderBy: { version: "desc" } }));
}
export async function requireTemplateManager(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { isActive: true, role: true } });
  if (!user?.isActive) throw new PaperworkError("Sign in with an active account.", 401);
  if (user.role !== "admin" && user.role !== "manager") throw new PaperworkError("Manager access is required to edit templates.", 403);
}
export async function getTemplateEditor(userId: string, query: { version?: number; operationId?: string } = {}) {
  await requireTemplateManager(userId);
  const revision = query.version !== undefined
    ? await prisma.driverPaperworkRevision.findUnique({ where: { version: query.version } })
    : query.operationId ? await prisma.driverPaperworkRevision.findUnique({ where: { operationId: query.operationId } }) : undefined;
  if (query.version !== undefined && query.version !== 0 && !revision) throw new PaperworkError("Template version not found.", 404);
  const history = await prisma.driverPaperworkRevision.findMany({ orderBy: { version: "desc" }, take: 50, select: { version: true, operationId: true, createdAt: true, createdByUser: { select: { displayName: true } } } });
  return {
    current: await getPublishedTemplate(),
    selected: query.version === 0 ? snapshot(null) : revision ? snapshot(revision) : null,
    history: history.map(item => ({ version: item.version, operationId: item.operationId, createdAt: item.createdAt.toISOString(), author: item.createdByUser?.displayName ?? "Former user" })),
  };
}
export async function saveTemplate(userId: string, input: unknown) {
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) throw new PaperworkError(parsed.error.issues[0]?.message ?? "Invalid template.", 400);
  const { expectedVersion, operationId, template, program } = parsed.data;
  if (!validateProgram(program)) throw new PaperworkError("JavaScript must compile and define function createDriverPaperworkRuntime(config, assets).", 400);
  const contentHash = createHash("sha256").update(JSON.stringify({ template, program })).digest("hex");
  return prisma.$transaction(async tx => {
    // Serialize publishers and lock the current account through the write, so a
    // concurrent role removal or stale browser cannot authorize a publication.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(681933114)`;
    const [user] = await tx.$queryRaw<{ role: string; isActive: boolean }[]>`SELECT "role", "isActive" FROM "User" WHERE "id" = ${userId} FOR SHARE`;
    if (!user?.isActive) throw new PaperworkError("Sign in with an active account.", 401);
    if (user.role !== "admin" && user.role !== "manager") throw new PaperworkError("Manager access is required to edit templates.", 403);
    const previous = await tx.driverPaperworkRevision.findUnique({ where: { operationId } });
    if (previous) {
      if (previous.createdByUserId !== userId || previous.contentHash !== contentHash || previous.baseVersion !== expectedVersion) throw new PaperworkError("This save identifier belongs to a different edit. Reload the current version.", 409);
      return snapshot(previous);
    }
    const latest = await tx.driverPaperworkRevision.findFirst({ orderBy: { version: "desc" }, select: { version: true } });
    const currentVersion = latest?.version ?? 0;
    if (expectedVersion !== currentVersion) throw new PaperworkError("Another manager saved a newer template. Reload it before saving your changes.", 409);
    return snapshot(await tx.driverPaperworkRevision.create({ data: { version: currentVersion + 1, template: template as Prisma.InputJsonValue, program, contentHash, operationId, baseVersion: expectedVersion, createdByUserId: userId } }));
  });
}
