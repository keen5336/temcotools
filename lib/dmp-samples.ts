import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import { AuthorizationError, type Principal } from "@/lib/auth/principal";
import { ADMIN_FILES_ROOT, readAdminFileBytes, secureAdminPath } from "@/lib/admin-files";
import { DmpSampleError, inspectSampleBody, MAX_SAMPLE_BYTES, SAMPLE_LIMITS, type SampleFormat } from "./dmp-samples/structure";
import { inspectRoutePlannerContext } from "./dmp-samples/route-context";
export { DmpSampleError, SAMPLE_LIMITS } from "./dmp-samples/structure";

const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const sampleId = fingerprint.describe("An opaque ID from your own sample list; never a managed filesystem path.");
const operationId = z.string().regex(/^[A-Za-z0-9:_-]{16,100}$/).describe("Retain this ID after a lost response. An uncertain file effect is never automatically replayed.");
const sourceDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value, "Use a real calendar day.");
const exactTime = z.string().datetime({ offset: true }).describe("An exact known timestamp with timezone. Leave absent when the source only supplies a day or a time without timezone.");
const provenance = z.object({
  sourceKind: z.enum(["dmp_export", "route_planner_export", "other_operational_export"]),
  sourceMethod: z.enum(["GET", "HEAD", "POST", "export", "unknown"]),
  sourceDay: sourceDay.optional(), sourceAsOf: exactTime.optional(), exportedAt: exactTime.optional(),
  reviewedBodyOnly: z.literal(true).describe("You reviewed this business response body/export: no credentials, cookies, headers, HAR or request/package wrapper. It remains private and manually supplied."),
}).strict();
export const dmpSamplesSaveInput = provenance.extend({
  operationId,
  receiptOnly: z.boolean().default(false).describe("Inspect this exact original save intent only. If no receipt exists, no new command or file operation is started."),
  format: z.enum(["json", "csv", "xml", "opaque"]),
  body: z.string().min(1).max(MAX_SAMPLE_BYTES).optional().describe("UTF-8 business body only, maximum 2 MiB. No URLs are followed and no content is executed."),
  managedFile: z.object({ path: z.string().min(1).max(2048), expectedFingerprint: fingerprint }).strict().optional().describe("Optional existing managed file: files.manage and this exact current version are required at save and inspection. XLS/XLSX stay opaque; convert an intentional copy to CSV for structure."),
  originalDmpOperationId: z.string().min(16).max(100).optional().describe("Optional original same-user successful GET/HEAD receipt. Its JSON.stringify(body) hash must match exactly. This never sends a request."),
}).strict().superRefine((value, context) => {
  if ((value.body !== undefined) === (value.managedFile !== undefined)) context.addIssue({ code: "custom", message: "Supply either one body or one current managed-file reference." });
  if (value.format === "opaque" && !value.managedFile) context.addIssue({ code: "custom", message: "Opaque XLS/XLSX remain in existing managed files; choose a current managed-file reference." });
  if (value.originalDmpOperationId && (value.sourceKind !== "dmp_export" || !["GET", "HEAD"].includes(value.sourceMethod) || value.format === "opaque")) context.addIssue({ code: "custom", message: "Receipt verification is restricted to an original DMP GET/HEAD body." });
});
export const dmpSamplesListInput = z.object({ beforeId: z.string().min(1).max(100).optional(), limit: z.number().int().min(1).max(50).default(20) }).strict();
export const dmpSamplesInspectInput = z.object({ sampleId, fieldPath: z.string().min(1).max(1200).optional(), offset: z.number().int().min(0).max(SAMPLE_LIMITS.nodes).default(0), limit: z.number().int().min(1).max(SAMPLE_LIMITS.returnedValues).default(10) }).strict().refine(value => value.fieldPath !== undefined || value.offset === 0, "A value cursor requires an explicit field path.");
export const dmpSamplesRemoveInput = z.object({ operationId, sampleId, expectedContentHash: fingerprint }).strict();
export const dmpSamplesRouteContextInput = z.object({ sampleId, routePath: z.string().min(1).max(1600).optional().describe("Exact sibling-indexed route sourcePath from this sample's context list. Selecting it explicitly reveals bounded raw route/stop/line records."), offset: z.number().int().min(0).max(SAMPLE_LIMITS.nodes).default(0), limit: z.number().int().min(1).max(SAMPLE_LIMITS.routeContextRecords).default(5), routeOffset: z.number().int().min(0).max(SAMPLE_LIMITS.nodes).default(0), routeLimit: z.number().int().min(1).max(50).default(20) }).strict().refine(value => value.routePath !== undefined || value.offset === 0, "A route cursor requires a selected route path.");
type Metadata = Record<string, unknown>;
type Summary = { sampleId: string; format: SampleFormat | "opaque"; contentHash: string; bytes: number; sourceKind: string; sourceMethod: string; sourceDay: string | null; sourceAsOf: string | null; exportedAt: string | null; capturedAt: string; provenance: "manual_body" | "managed_file" | "verified_original_read_body"; originalDmpOperationId: string | null; qualification: "manual_sample_only" };
type Envelope = { version: 1; actorUserId: string; summary: Summary; managedFile?: { path: string; expectedFingerprint: string }; body?: string };
type Receipt = { ok: boolean; operationId: string; status: "completed" | "unknown" | "not_applied"; sample?: Summary; inspectionSampleId?: string; removedSampleId?: string; error?: string };
const parse = (value: string | null): Metadata => { try { return JSON.parse(value ?? "{}"); } catch { throw new DmpSampleError("The original sample receipt is unavailable. Inspect the existing sample before a new operation.", 409, "unknown_effect"); } };

// Reuse the managed private root/path guards and file-command custody pattern.
// workflow.read never accepts a general path or another user's storage scope.
export function createDmpSampleCommands(configuredRoot = ADMIN_FILES_ROOT) {
  const root = path.resolve(/* turbopackIgnore: true */ configuredRoot);
  const userDirectory = (principal: Principal) => `dmp-samples/${sha(principal.userId)}`;
  const filePath = (principal: Principal, id: string) => `${userDirectory(principal)}/${id}.json`;
  async function audit(tx: Prisma.TransactionClient, principal: Principal, action: string, metadata: Metadata, sourceHash?: string) {
    await tx.identityAudit.create({ data: { actorUserId: principal.userId, sessionId: principal.sessionId, action: `dmp_sample.${action}`, sourceHash, reason: JSON.stringify({ ...metadata, grantId: principal.grantId ?? null }) } });
  }
  async function lock(tx: Prisma.TransactionClient, principal: Principal) { await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`dmp-samples:${root}:${principal.userId}`}, 813))`; }
  async function directory(principal: Principal, dispatch: () => void) {
    await secureAdminPath("", root);
    for (const relative of ["dmp-samples", userDirectory(principal)]) {
      const target = await secureAdminPath(relative, root, true);
      if (!target.exists) { dispatch(); await fs.mkdir(target.resolved, { mode: 0o700 }); }
      else if (!(await fs.lstat(target.resolved)).isDirectory()) throw new DmpSampleError("Private sample storage is unavailable.", 409);
    }
  }
  async function load(principal: Principal, id: string): Promise<Envelope> {
    const file = await readAdminFileBytes(filePath(principal, id), root);
    if (file.bytes.length > MAX_SAMPLE_BYTES * 7) throw new DmpSampleError("Stored sample exceeds its envelope limit.", 413);
    let stored: Envelope;
    try { stored = JSON.parse(file.bytes.toString("utf8")); } catch { throw new DmpSampleError("This private sample is unreadable.", 409); }
    if (stored.version !== 1 || stored.actorUserId !== principal.userId || stored.summary?.sampleId !== id) throw new DmpSampleError("This sample is unavailable in your scope.", 404);
    if (stored.body !== undefined && (Buffer.byteLength(stored.body) !== stored.summary.bytes || sha(stored.body) !== stored.summary.contentHash)) throw new DmpSampleError("The stored sample changed. Use a new reviewed intake.", 409);
    return stored;
  }
  async function checkManaged(tx: Prisma.TransactionClient, principal: Principal, reference: NonNullable<Envelope["managedFile"]>) {
    await assertCurrentPrincipal(tx, principal, "files.manage");
    const file = await readAdminFileBytes(reference.path, root);
    if (file.fingerprint !== reference.expectedFingerprint) throw new DmpSampleError("The managed file changed. Reload its current fingerprint before intake or inspection.", 409, "stale_file");
    if (file.bytes.length > MAX_SAMPLE_BYTES) throw new DmpSampleError("Pilot sample files are limited to 2 MiB. Existing larger exports remain available in managed files.", 413);
    return file;
  }
  async function loadForInspection(tx: Prisma.TransactionClient, principal: Principal, id: string) {
    const stored = await load(principal, id);
    if (stored.managedFile) {
      const file = await checkManaged(tx, principal, stored.managedFile);
      if (sha(stored.summary.format === "opaque" ? file.bytes : new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)) !== stored.summary.contentHash) throw new DmpSampleError("The managed file content changed. Use a new reviewed intake.", 409, "stale_file");
    }
    return stored;
  }
  async function mutate(principal: Principal, action: "save" | "remove", id: string, inputFingerprint: string, run: (tx: Prisma.TransactionClient, actor: Principal, dispatch: () => void) => Promise<Omit<Receipt, "ok" | "operationId" | "status">>, receiptOnly = false): Promise<Receipt> {
    const sourceHash = sha(`dmp-sample:${root}:${principal.userId}:${id}`);
    const previous = await prisma.$transaction(async tx => {
      const actor = await assertCurrentPrincipal(tx, principal, "workflow.read"); await lock(tx, actor);
      const started = await tx.identityAudit.findFirst({ where: { actorUserId: actor.userId, sourceHash, action: "dmp_sample.operation_started" } });
      if (started) {
        if (parse(started.reason).inputFingerprint !== inputFingerprint) throw new DmpSampleError("This operation ID belongs to different sample work.", 409, "idempotency_conflict");
        const settled = await tx.identityAudit.findFirst({ where: { actorUserId: actor.userId, sourceHash, action: { in: ["dmp_sample.operation_completed", "dmp_sample.operation_unknown", "dmp_sample.operation_not_applied"] } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
        return settled ? parse(settled.reason).receipt as Receipt : { ok: false, operationId: id, status: "unknown" as const, ...(action === "save" ? { inspectionSampleId: sha(`sample:${actor.userId}:${id}`) } : {}), error: "This sample operation is in progress or uncertain. Inspect its sample before a new operation; it was not replayed." };
      }
      if (receiptOnly) return { ok: false, operationId: id, status: "not_applied" as const, error: "No original save receipt was found. This receipt check did not start a command or file operation." };
      await audit(tx, actor, "operation_started", { operationId: id, action, inputFingerprint }, sourceHash); return null;
    });
    if (previous) return previous;
    let dispatched = false;
    try {
      return await prisma.$transaction(async tx => {
        const actor = await assertCurrentPrincipal(tx, principal, "workflow.read"); await lock(tx, actor);
        const result = await run(tx, actor, () => { dispatched = true; });
        const receipt: Receipt = { ok: true, operationId: id, status: "completed", ...result };
        await audit(tx, actor, "operation_completed", { operationId: id, action, receipt }, sourceHash); return receipt;
      }, { timeout: 30_000 });
    } catch (error) {
      const receipt: Receipt = { ok: false, operationId: id, status: dispatched ? "unknown" : "not_applied", ...(action === "save" ? { inspectionSampleId: sha(`sample:${principal.userId}:${id}`) } : {}), error: dispatched ? "The private file result is uncertain. Inspect this sample before a new operation; no automatic retry will occur." : error instanceof DmpSampleError || error instanceof AuthorizationError ? error.message : "Sample retention could not start." };
      await prisma.$transaction(tx => audit(tx, principal, dispatched ? "operation_unknown" : "operation_not_applied", { operationId: id, action, receipt }, sourceHash)).catch(() => undefined);
      return receipt;
    }
  }
  async function saveDmpSample(principal: Principal, raw: unknown) {
    const { receiptOnly, ...data } = dmpSamplesSaveInput.parse(raw);
    if (data.body !== undefined) inspectSampleBody(data.format as SampleFormat, data.body);
    const inputFingerprint = sha(JSON.stringify({ ...data, body: data.body === undefined ? undefined : sha(data.body) }));
    return mutate(principal, "save", data.operationId, inputFingerprint, async (tx, actor, dispatch) => {
      let body = data.body, bytes: Buffer | undefined;
      if (data.managedFile) { const file = await checkManaged(tx, actor, data.managedFile); bytes = file.bytes; if (data.format === "opaque") { if (!/\.(?:xlsx|xls)$/i.test(file.filename)) throw new DmpSampleError("Only existing XLS/XLSX exports use opaque inspection."); } else { body = new TextDecoder("utf-8", { fatal: true }).decode(bytes); inspectSampleBody(data.format, body); } }
      if (data.originalDmpOperationId) {
        const original = await tx.dmpOperation.findUnique({ where: { actorUserId_operationId: { actorUserId: actor.userId, operationId: data.originalDmpOperationId } } });
        if (!original || !["GET", "HEAD"].includes(original.method) || original.method !== data.sourceMethod || original.state !== "response_observed" || !original.upstreamStatus || original.upstreamStatus < 200 || original.upstreamStatus >= 300 || original.responseHash !== sha(JSON.stringify(body))) throw new DmpSampleError("The exact original same-user successful GET/HEAD body receipt does not match. No network request was sent.", 409);
      }
      const id = sha(`sample:${actor.userId}:${data.operationId}`), capturedAt = new Date().toISOString();
      const summary: Summary = { sampleId: id, format: data.format, contentHash: sha(body ?? bytes!), bytes: body === undefined ? bytes!.length : Buffer.byteLength(body), sourceKind: data.sourceKind, sourceMethod: data.sourceMethod, sourceDay: data.sourceDay ?? null, sourceAsOf: data.sourceAsOf ?? null, exportedAt: data.exportedAt ?? null, capturedAt, provenance: data.originalDmpOperationId ? "verified_original_read_body" : data.managedFile ? "managed_file" : "manual_body", originalDmpOperationId: data.originalDmpOperationId ?? null, qualification: "manual_sample_only" };
      await directory(actor, dispatch);
      const entries = await fs.readdir((await secureAdminPath(userDirectory(actor), root)).resolved);
      if (entries.length >= 100) throw new DmpSampleError("Pilot retention is limited to 100 private samples per person. Remove an unneeded sample first.", 413);
      const target = await secureAdminPath(filePath(actor, id), root, true);
      if (target.exists) throw new DmpSampleError("This sample already exists. Inspect it; do not replay an uncertain save.", 409);
      const temporary = path.join(path.dirname(target.resolved), `.temco-upload-${randomUUID()}`);
      const envelope: Envelope = { version: 1, actorUserId: actor.userId, summary, ...(data.managedFile ? { managedFile: data.managedFile } : {}), ...(body === undefined ? {} : { body }) };
      dispatch(); const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(JSON.stringify(envelope)); await handle.sync(); } finally { await handle.close(); }
      try { await fs.link(temporary, target.resolved); await fs.unlink(temporary); } catch (error) { await fs.unlink(temporary).catch(() => undefined); throw error; }
      await audit(tx, actor, "saved", { sample: summary });
      return { sample: summary };
    }, receiptOnly);
  }
  async function listDmpSamples(principal: Principal, raw: unknown = {}) {
    const data = dmpSamplesListInput.parse(raw);
    return prisma.$transaction(async tx => {
      const actor = await assertCurrentPrincipal(tx, principal, "workflow.read"); await lock(tx, actor);
      if (data.beforeId && !await tx.identityAudit.findFirst({ where: { id: data.beforeId, actorUserId: actor.userId, action: "dmp_sample.saved" } })) throw new DmpSampleError("Choose a continuation from your own sample list.", 400);
      const rows = await tx.identityAudit.findMany({ where: { actorUserId: actor.userId, action: "dmp_sample.saved" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], ...(data.beforeId ? { cursor: { id: data.beforeId }, skip: 1 } : {}), take: data.limit + 1 });
      const samples = await Promise.all(rows.slice(0, data.limit).map(async row => {
        const summary = parse(row.reason).sample as Summary;
        let retained = false; try { const target = await secureAdminPath(filePath(actor, sampleId.parse(summary.sampleId)), root); retained = (await fs.lstat(target.resolved)).isFile(); } catch { /* Removed or unavailable; metadata is retained, never a body substitute. */ }
        return { ...summary, retained };
      }));
      const starts = await tx.identityAudit.findMany({ where: { actorUserId: actor.userId, action: "dmp_sample.operation_started" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 20 });
      const unsettled = (await Promise.all(starts.map(async row => {
        const start = parse(row.reason), last = await tx.identityAudit.findFirst({ where: { actorUserId: actor.userId, sourceHash: row.sourceHash, action: { in: ["dmp_sample.operation_completed", "dmp_sample.operation_unknown", "dmp_sample.operation_not_applied"] } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
        if (last && last.action !== "dmp_sample.operation_unknown") return null;
        return { operationId: String(start.operationId), action: String(start.action), status: "unknown" as const, inspectionSampleId: start.action === "save" ? sha(`sample:${actor.userId}:${start.operationId}`) : null };
      }))).filter(value => value !== null);
      await audit(tx, actor, "listed", { returnedCount: samples.length });
      return { samples, unsettled, unsettledWindow: "Most recent 20 sample commands only; keep your original operation ID for older receipts.", nextBeforeId: rows.length > data.limit ? rows[data.limit - 1].id : null, limits: SAMPLE_LIMITS, qualification: "Private manually retained evidence. No DMP/Route Planner adapter or full-day coverage has been qualified." };
    });
  }
  async function inspectDmpSample(principal: Principal, raw: unknown) {
    const data = dmpSamplesInspectInput.parse(raw);
    return prisma.$transaction(async tx => {
      const actor = await assertCurrentPrincipal(tx, principal, "workflow.read"); await lock(tx, actor);
      const stored = await loadForInspection(tx, actor, data.sampleId);
      const result = stored.summary.format === "opaque" ? { status: "opaque_export" as const, message: "This existing XLS/XLSX export remains in private managed files. No worksheet structure was inspected. Save an intentional UTF-8 CSV copy for bounded structure; this sample grants no general file access." } : { status: "inspected" as const, ...inspectSampleBody(stored.summary.format, stored.body!, data.fieldPath ? { fieldPath: data.fieldPath, offset: data.offset, limit: data.limit } : undefined) };
      await audit(tx, actor, "inspected", { sampleId: data.sampleId, valuesRequested: data.fieldPath !== undefined, offset: data.offset, limit: data.limit });
      return { sample: stored.summary, ...result };
    }, { timeout: 30_000 });
  }
  async function getDmpSampleRouteContext(principal: Principal, raw: unknown) {
    const data = dmpSamplesRouteContextInput.parse(raw);
    return prisma.$transaction(async tx => {
      const actor = await assertCurrentPrincipal(tx, principal, "workflow.read"); await lock(tx, actor);
      const stored = await loadForInspection(tx, actor, data.sampleId);
      if (stored.summary.sourceKind !== "route_planner_export" || stored.summary.format !== "xml" || stored.body === undefined) throw new DmpSampleError("Route context requires a reviewed Route Planner XML body. Other exports remain available through generic structure inspection.");
      const context = inspectRoutePlannerContext(stored.body, data);
      await audit(tx, actor, "route_context_inspected", { sampleId: data.sampleId, routeSelected: data.routePath !== undefined, offset: data.offset, limit: data.limit });
      return { sample: stored.summary, ...context };
    }, { timeout: 30_000 });
  }
  async function removeDmpSample(principal: Principal, raw: unknown) {
    const data = dmpSamplesRemoveInput.parse(raw);
    return mutate(principal, "remove", data.operationId, sha(JSON.stringify(data)), async (tx, actor, dispatch) => {
      const stored = await load(actor, data.sampleId);
      if (stored.summary.contentHash !== data.expectedContentHash) throw new DmpSampleError("The sample changed. Inspect its current version before removal.", 409);
      const target = await secureAdminPath(filePath(actor, data.sampleId), root);
      dispatch(); await fs.unlink(target.resolved);
      await audit(tx, actor, "removed", { sampleId: data.sampleId, contentHash: data.expectedContentHash }); return { removedSampleId: data.sampleId };
    });
  }
  return { saveDmpSample, listDmpSamples, inspectDmpSample, removeDmpSample, getDmpSampleRouteContext };
}
export const { saveDmpSample, listDmpSamples, inspectDmpSample, removeDmpSample, getDmpSampleRouteContext } = createDmpSampleCommands();
