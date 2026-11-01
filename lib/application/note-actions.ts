import * as notes from "@/lib/warehouse/notes";
export const noteActions = {
  "warehouse.notes": { capability: "inventory.read", description: "Page attributed unit notes; notes never authorize handling or movement", inputSchema: notes.listWarehouseUnitNotesSchema, run: notes.listWarehouseUnitNotes },
  "warehouse.note": { capability: "inventory.read", description: "Read a note and immutable correction history", inputSchema: notes.getWarehouseUnitNoteSchema, run: notes.getWarehouseUnitNote },
  "warehouse.note.append": { capability: "inventory.write", description: "Append a note with current individual attribution and stable operationId", inputSchema: notes.appendWarehouseUnitNoteSchema, run: notes.appendWarehouseUnitNote },
  "warehouse.note.correct": { capability: "inventory.write", description: "Correct/withdraw/restore with expectedRevision and reason; other-author corrections also require office authority", inputSchema: notes.correctWarehouseUnitNoteSchema, run: notes.correctWarehouseUnitNote },
} as const;
