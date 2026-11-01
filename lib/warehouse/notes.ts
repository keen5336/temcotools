import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertCapability, type Principal } from "@/lib/auth/principal";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import { localCommandReceipt } from "@/lib/application/command-receipts";
import { WarehouseCommandError } from "./units";

const id = z.string().trim().min(1).max(200);
const operationId = z.string().regex(/^[A-Za-z0-9:_-]{16,150}$/, "Provide a stable operation ID of 16–150 letters, digits, colons, underscores or hyphens.");
const body = z.string().trim().min(1).max(4000);
const reason = z.string().trim().min(5).max(2000);
export const listWarehouseUnitNotesSchema = z.object({ unitId: id, afterId: id.optional(), limit: z.number().int().min(1).max(100).default(30), includeTombstoned: z.boolean().default(true) }).strict();
export const getWarehouseUnitNoteSchema = z.object({ noteId: id, beforeRevision: z.number().int().positive().optional(), limit: z.number().int().min(1).max(100).default(20) }).strict();
export const appendWarehouseUnitNoteSchema = z.object({ operationId, unitId: id, body }).strict();
export const correctWarehouseUnitNoteSchema = z.object({ operationId, noteId: id, expectedRevision: z.number().int().positive(), action: z.enum(["correct", "tombstone", "restore"]), body: body.optional(), reason }).strict().superRefine((input, ctx) => {
  if (input.action !== "tombstone" && input.body === undefined) ctx.addIssue({ code: "custom", path: ["body"], message: "Provide the corrected/restored note text." });
  if (input.action === "tombstone" && input.body !== undefined) ctx.addIssue({ code: "custom", path: ["body"], message: "A tombstone withdraws the note; its prior text stays in history." });
});
export const warehouseNoteMeaning = "Notes provide attributed context. They do not authorize a disposition, RTV submission, movement or printing; use the corresponding authorized workflow.";

type NoteWithRevision = Prisma.WarehouseUnitNoteGetPayload<{ include: { revisions: true } }>;
function noteView(note: NoteWithRevision) {
  const current = note.revisions.find((revision) => revision.revision === note.currentRevision);
  if (!current) throw new WarehouseCommandError("Note history is incomplete. Ask an administrator to review its saved revisions.", 503);
  return { noteId: note.id, unitId: note.unitId, authorUserId: note.authorUserId, authorUsername: note.authorUsername, authorName: note.authorName, revision: note.currentRevision, state: note.state, body: note.state === "tombstoned" ? "" : current.body, latestAction: current.action, latestReason: current.reason, updatedByUserId: current.editedByUserId, updatedByName: current.editorName, createdAt: note.createdAt.toISOString(), updatedAt: note.updatedAt.toISOString() };
}
function revisionView(revision: Prisma.WarehouseUnitNoteRevisionGetPayload<object>) {
  return { revision: revision.revision, action: revision.action, body: revision.body, reason: revision.reason, editedByUserId: revision.editedByUserId, editorUsername: revision.editorUsername, editorName: revision.editorName, correctedOtherAuthor: revision.correctedOtherAuthor, createdAt: revision.createdAt.toISOString() };
}

export async function listWarehouseUnitNotes(principal: Principal, raw: unknown, transaction?: Prisma.TransactionClient) {
  assertCapability(principal, "inventory.read");
  const input = listWarehouseUnitNotesSchema.parse(raw);
  const run = async (tx: Prisma.TransactionClient) => {
    if (!await tx.warehouseUnit.findUnique({ where: { id: input.unitId }, select: { id: true } })) throw new WarehouseCommandError("Physical unit not found.", 404);
    const notes = await tx.warehouseUnitNote.findMany({ where: { unitId: input.unitId, ...(input.includeTombstoned ? {} : { state: "active" }), ...(input.afterId ? { id: { lt: input.afterId } } : {}) }, include: { revisions: { orderBy: { revision: "desc" }, take: 1 } }, orderBy: { id: "desc" }, take: input.limit + 1 });
    return { unitId: input.unitId, notes: notes.slice(0, input.limit).map(noteView), nextAfterId: notes.length > input.limit ? notes[input.limit - 1].id : null, meaning: warehouseNoteMeaning };
  };
  return transaction ? run(transaction) : prisma.$transaction(run, { isolationLevel: "RepeatableRead" });
}

export async function getWarehouseUnitNote(principal: Principal, raw: unknown) {
  assertCapability(principal, "inventory.read");
  const input = getWarehouseUnitNoteSchema.parse(raw);
  return prisma.$transaction(async (tx) => {
    const note = await tx.warehouseUnitNote.findUnique({ where: { id: input.noteId }, include: { revisions: { orderBy: { revision: "desc" }, take: 1 } } });
    if (!note) throw new WarehouseCommandError("Physical-unit note not found.", 404);
    const revisions = await tx.warehouseUnitNoteRevision.findMany({ where: { noteId: note.id, ...(input.beforeRevision ? { revision: { lt: input.beforeRevision } } : {}) }, orderBy: { revision: "desc" }, take: input.limit + 1 });
    return { note: noteView(note), revisions: revisions.slice(0, input.limit).map(revisionView), nextBeforeRevision: revisions.length > input.limit ? revisions[input.limit - 1].revision : null, meaning: warehouseNoteMeaning };
  }, { isolationLevel: "RepeatableRead" });
}

export async function appendWarehouseUnitNote(principal: Principal, raw: unknown) {
  assertCapability(principal, "inventory.write");
  const input = appendWarehouseUnitNoteSchema.parse(raw);
  return prisma.$transaction(async (tx) => {
    const current = await assertCurrentPrincipal(tx, principal, "inventory.write");
    return localCommandReceipt(tx, current, "warehouse.note.append", input.operationId, input, async () => {
      if (!await tx.warehouseUnit.findUnique({ where: { id: input.unitId }, select: { id: true } })) throw new WarehouseCommandError("Physical unit not found.", 404);
      const note = await tx.warehouseUnitNote.create({ data: { unitId: input.unitId, authorUserId: current.userId, authorUsername: current.username, authorName: current.displayName, revisions: { create: { revision: 1, action: "append", body: input.body, editedByUserId: current.userId, editorUsername: current.username, editorName: current.displayName } } }, include: { revisions: true } });
      return { note: noteView(note), meaning: warehouseNoteMeaning };
    });
  });
}

export async function correctWarehouseUnitNote(principal: Principal, raw: unknown) {
  assertCapability(principal, "inventory.write");
  const input = correctWarehouseUnitNoteSchema.parse(raw);
  return prisma.$transaction(async (tx) => {
    let current = await assertCurrentPrincipal(tx, principal, "inventory.write");
    await tx.$executeRaw`SELECT id FROM "WarehouseUnitNote" WHERE id=${input.noteId} FOR UPDATE`;
    const note = await tx.warehouseUnitNote.findUnique({ where: { id: input.noteId } });
    if (!note) throw new WarehouseCommandError("Physical-unit note not found.", 404);
    const correctedOtherAuthor = note.authorUserId !== current.userId;
    if (correctedOtherAuthor) current = await assertCurrentPrincipal(tx, principal, "office.decide");
    return localCommandReceipt(tx, current, "warehouse.note.correct", input.operationId, input, async () => {
      if (note.currentRevision !== input.expectedRevision) throw new WarehouseCommandError("This note changed. Reload its current revision before correcting it.", 409);
      if (input.action === "restore" && note.state !== "tombstoned") throw new WarehouseCommandError("This note is already active. Use correction instead.", 409);
      if (input.action !== "restore" && note.state === "tombstoned") throw new WarehouseCommandError("This note is withdrawn. Restore it explicitly with new text and a reason.", 409);
      const revision = note.currentRevision + 1;
      await tx.warehouseUnitNoteRevision.create({ data: { noteId: note.id, revision, action: input.action, body: input.action === "tombstone" ? "" : input.body!, reason: input.reason, editedByUserId: current.userId, editorUsername: current.username, editorName: current.displayName, correctedOtherAuthor } });
      const updated = await tx.warehouseUnitNote.update({ where: { id: note.id }, data: { currentRevision: revision, state: input.action === "tombstone" ? "tombstoned" : "active", updatedAt: new Date() }, include: { revisions: { orderBy: { revision: "desc" }, take: 1 } } });
      return { note: noteView(updated), meaning: warehouseNoteMeaning };
    });
  });
}
