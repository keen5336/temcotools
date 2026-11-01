import { createHash } from "node:crypto";

export class OfficeError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "OfficeError"; }
}
export function fingerprint(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function businessDay(at: Date, zone = process.env.WAREHOUSE_TIME_ZONE || "America/Chicago") {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
export function calendarDays(from: Date, to: Date) { return Math.floor((Date.parse(`${businessDay(to)}T00:00:00Z`) - Date.parse(`${businessDay(from)}T00:00:00Z`)) / 86_400_000); }

export interface PhysicalFact { id: string; type: string; location: string | null; capturedAt: Date; receivedAt: Date }
export function deriveCustody(observations: PhysicalFact[]) {
  const ordered = [...observations].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime() || a.id.localeCompare(b.id));
  const last = ordered.at(-1) ?? null;
  const sameTime = last ? ordered.filter((item) => item.capturedAt.getTime() === last.capturedAt.getTime()) : [];
  const conflict = sameTime.some((item) => item.type !== last?.type || item.location !== last?.location);
  const departure = [...ordered].reverse().find((item) => item.type === "departure") ?? null;
  const currentCheckIn = ordered.find((item) => item.type === "check_in" && (!departure || item.capturedAt > departure.capturedAt)) ?? null;
  return { last, conflict, currentCheckIn, departure, warehouseEvidence: Boolean(last && last.type !== "departure" && !conflict) };
}

export function iso(value: Date | null | undefined) { return value?.toISOString() ?? null; }
export function plain<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
