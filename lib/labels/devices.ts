import { createHash, randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertCapability, type Principal } from "@/lib/auth/principal";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import { LabelError } from "./model";

export const hashDeviceToken = (value: string) => createHash("sha256").update(value).digest("hex");
const deviceFields = { id: true, userId: true, sessionId: true, name: true, mode: true, printerIds: true, lastSeenAt: true, leaseExpiresAt: true, revokedAt: true } as const;
export async function registerPrintingDevice(principal: Principal, input: unknown) {
  const data = z.object({ deviceId: z.string().min(16).max(100), name: z.string().trim().min(1).max(80), mode: z.enum(["direct", "relay"]), printerIds: z.array(z.string().min(1).max(100)).min(1).max(40), deviceToken: z.string().max(100).optional() }).parse(input);
  return prisma.$transaction(async tx => {
    await assertCurrentPrincipal(tx, principal, "labels.print");
    const printers = await tx.labelPrinter.findMany({ where: { id: { in: data.printerIds }, isActive: true }, select: { id: true } });
    if (printers.length !== new Set(data.printerIds).size) throw new LabelError("Select only currently active managed printers.");
    const current = await tx.printingDevice.findUnique({ where: { id: data.deviceId } });
    if (current && (current.userId !== principal.userId || current.sessionId !== principal.sessionId || !data.deviceToken || current.tokenHash !== hashDeviceToken(data.deviceToken) || current.revokedAt)) throw new LabelError("Reconnect this device under the current person/session.", 409, "device_reconnect");
    const token = current ? data.deviceToken! : randomBytes(32).toString("base64url"), at = new Date();
    const values = { userId: principal.userId, sessionId: principal.sessionId!, authVersion: principal.authVersion, tokenHash: hashDeviceToken(token), name: data.name, mode: data.mode, printerIds: [...new Set(data.printerIds)], lastSeenAt: at, leaseExpiresAt: new Date(at.getTime() + 90_000) };
    const device = await tx.printingDevice.upsert({ where: { id: data.deviceId }, create: { id: data.deviceId, ...values }, update: values, select: deviceFields });
    return { device, deviceToken: token };
  });
}
export async function listPrintingDevices(principal: Principal) {
  assertCapability(principal, "labels.read");
  return prisma.printingDevice.findMany({ where: { revokedAt: null, leaseExpiresAt: { gt: new Date() }, OR: [{ userId: principal.userId, sessionId: principal.sessionId }, { mode: "relay" }] }, select: deviceFields, orderBy: { name: "asc" } });
}
export async function revokePrintingDevice(principal: Principal, deviceId: string) {
  return prisma.$transaction(async tx => {
    await assertCurrentPrincipal(tx, principal, "labels.print");
    const result = await tx.printingDevice.updateMany({ where: { id: deviceId, userId: principal.userId, sessionId: principal.sessionId }, data: { revokedAt: new Date() } });
    return { revoked: result.count > 0 };
  });
}
export async function currentPrintingDevice(tx: Prisma.TransactionClient, principal: Principal, deviceId: string, token: string) {
  await assertCurrentPrincipal(tx, principal, "labels.print");
  const device = await tx.printingDevice.findUnique({ where: { id: deviceId } });
  if (!device || device.userId !== principal.userId || device.sessionId !== principal.sessionId || device.authVersion !== principal.authVersion || device.revokedAt || device.leaseExpiresAt.getTime() <= Date.now() || device.tokenHash !== hashDeviceToken(token)) throw new LabelError("The selected printing device is unavailable or belongs to another session.", 403, "device_unavailable");
  return device;
}
