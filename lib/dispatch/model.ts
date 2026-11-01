import { createHash } from "node:crypto";
import { z } from "zod";

export class DispatchError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "DispatchError"; }
}
export const dispatchId = z.string().trim().min(1).max(200);
export const dispatchOperation = z.string().trim().min(1).max(150);
export const dispatchReason = z.string().trim().min(5).max(2000);
export const dispatchStamp = z.string().datetime({ offset: true });
export const dispatchDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => { const date = new Date(`${value}T00:00:00Z`); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value; }, "Choose a valid dispatch date.");
export const dispatchIdentifier = z.object({ kind: z.enum(["lpn", "msn", "serial", "submission"]), value: z.string().trim().min(1).max(500).transform((value) => value.toUpperCase()), namespace: z.string().trim().min(1).max(100).transform((value) => value.toLowerCase()).optional() }).strict();
export const dispatchExpectedUnit = z.object({ unitId: dispatchId.optional(), identifiers: z.array(dispatchIdentifier).max(8).default([]) }).strict();
export const dispatchLine = z.object({ lineKey: z.string().trim().min(1).max(100), quantity: z.number().int().min(1).max(100), lane: z.string().trim().min(1).max(100).transform((value) => value.toUpperCase()), route: z.string().trim().min(1).max(100), orderReference: z.string().trim().max(200).default(""), description: z.string().trim().max(1000).default(""), partNumber: z.string().trim().max(200).default(""), expectedUnits: z.array(dispatchExpectedUnit).max(100).default([]) }).strict();
export type DispatchLine = z.infer<typeof dispatchLine>;
export const dispatchSlot = z.object({ slotKey: z.string().min(1).max(200), lineKey: z.string(), slotNumber: z.number().int(), lineQuantity: z.number().int(), lane: z.string(), route: z.string(), orderReference: z.string(), description: z.string(), partNumber: z.string(), expectedUnit: dispatchExpectedUnit, constraintHash: z.string() });
export type DispatchSlot = z.infer<typeof dispatchSlot>;
export function dispatchHash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function dispatchPlain<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
export function expandDispatchLines(lines: DispatchLine[]): DispatchSlot[] {
  if (lines.length > 500) throw new DispatchError("Provide at most 500 delivery lines; an explicitly reviewed complete scope may be empty.");
  const keys = new Set<string>(); const routeLanes = new Map<string, string>(); const slots: DispatchSlot[] = [];
  for (const line of lines) {
    if (keys.has(line.lineKey)) throw new DispatchError("Line keys must be unique within a snapshot.");
    keys.add(line.lineKey);
    if (line.expectedUnits.length && line.expectedUnits.length !== line.quantity) throw new DispatchError("When exact units are supplied, provide one identity group for each line quantity.");
    if (routeLanes.has(line.route) && routeLanes.get(line.route) !== line.lane) throw new DispatchError("One route must have one explicit physical lane within this snapshot.");
    routeLanes.set(line.route, line.lane);
    for (let index = 0; index < line.quantity; index++) {
      const expectedUnit = line.expectedUnits[index] ?? { identifiers: [] };
      const slot = { slotKey: JSON.stringify([line.lineKey, index + 1]), lineKey: line.lineKey, slotNumber: index + 1, lineQuantity: line.quantity, lane: line.lane, route: line.route, orderReference: line.orderReference, description: line.description, partNumber: line.partNumber, expectedUnit };
      slots.push({ ...slot, constraintHash: dispatchHash(slot) });
    }
  }
  if (slots.length > 5000) throw new DispatchError("A dispatch snapshot may contain at most 5,000 physical unit slots.");
  return slots;
}
export const dispatchSourceNotice = "Manual reviewed/workbook demand: DMP field mapping and Ashe's official-finals equivalence are pending qualification. This is not an official DMP finals source.";
