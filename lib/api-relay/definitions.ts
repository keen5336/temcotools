import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { dmpConfig } from "./config";
import { DEFAULT_RELAY_PROGRAM, RelayError, relaySaveInput, relayDefinitionsOverlap, resolveRelayDefinition, validateRelayFields, type RelayDefinition } from "./model";
import { livePasswordSession } from "@/lib/auth/sessions";

export function builtinDmpDefinition(): RelayDefinition {
  const config = dmpConfig();
  return { id: "dmp", name: "DMP", enabled: config.configured, origins: config.origins, pathPrefix: "/", identityPath: config.identity?.path || "/identity/me", subjectPath: config.subjectPath || "subject", operations: config.operations, program: DEFAULT_RELAY_PROGRAM, revision: 0 };
}

const decode = (row: { operations: unknown } & Omit<RelayDefinition, "operations">) => ({ ...row, operations: row.operations as RelayDefinition["operations"] });

export async function listRelayDefinitions(db: Pick<Prisma.TransactionClient, "apiRelayDefinition"> = prisma): Promise<RelayDefinition[]> {
  const rows = (await db.apiRelayDefinition.findMany({ orderBy: { name: "asc" } })).map(decode);
  // Preserve current DMP environment settings until an admin explicitly saves
  // its managed definition. Reads never insert or re-enable a disabled relay.
  return rows.some(row => row.id === "dmp") ? rows : [builtinDmpDefinition(), ...rows];
}

export async function currentRelayAdmin(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { isActive: true, role: true } });
  if (!user?.isActive) throw new RelayError("Sign in with an active account.", 401);
  if (user.role !== "admin") throw new RelayError("Only administrators can manage API relays.", 403);
}

export async function getRelayManager(userId: string) {
  await currentRelayAdmin(userId);
  return { definitions: await listRelayDefinitions(), history: await prisma.apiRelayRevision.findMany({ orderBy: { createdAt: "desc" }, take: 50, select: { relayId: true, revision: true, createdAt: true, createdByUserId: true, snapshot: true, operationId: true } }) };
}

export async function saveRelayDefinition(userId: string, input: unknown) {
  const parsed = relaySaveInput.safeParse(input);
  if (!parsed.success) throw new RelayError(parsed.error.issues[0]?.message || "Invalid relay definition.");
  const { expectedRevision, operationId, ...raw } = parsed.data;
  const fields = validateRelayFields(raw);
  const contentHash = createHash("sha256").update(JSON.stringify(fields)).digest("hex");
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(8110119)`;
    const [actor] = await tx.$queryRaw<{ role: string; isActive: boolean }[]>`SELECT "role", "isActive" FROM "User" WHERE id=${userId} FOR SHARE`;
    if (!actor?.isActive) throw new RelayError("Sign in with an active account.", 401);
    if (actor.role !== "admin") throw new RelayError("Only administrators can manage API relays.", 403);
    const previous = await tx.apiRelayRevision.findUnique({ where: { operationId } });
    if (previous) {
      if (previous.createdByUserId !== userId || previous.contentHash !== contentHash || previous.baseRevision !== expectedRevision) throw new RelayError("This save identifier belongs to another edit. Reload before saving.", 409);
      return previous.snapshot as unknown as RelayDefinition;
    }
    const definitions = await listRelayDefinitions(tx);
    const existing = definitions.find(row => row.id === fields.id);
    if ((existing?.revision ?? 0) !== expectedRevision) throw new RelayError("This relay changed. Reload its current revision before saving.", 409);
    if (definitions.some(row => row.id !== fields.id && relayDefinitionsOverlap(row, fields))) throw new RelayError("This site's path overlaps another relay rule. Edit that rule or choose separate paths.", 409);
    const revision = expectedRevision + 1;
    const data = { ...fields, operations: fields.operations as Prisma.InputJsonValue, revision };
    await tx.apiRelayDefinition.upsert({ where: { id: fields.id }, create: data, update: data });
    const snapshot = { ...fields, revision };
    await tx.apiRelayRevision.create({ data: { relayId: fields.id, revision, baseRevision: expectedRevision, operationId, contentHash, createdByUserId: userId, snapshot: snapshot as unknown as Prisma.InputJsonValue } });
    return snapshot;
  });
}

export async function validateRelayBinding(binding: { relayId?: string; relayRevision?: number; origin?: string; pathname?: string; owner?: { userId?: string; sessionId?: string } }) {
  if (!binding.relayId || !binding.origin || !binding.pathname || !binding.owner?.userId) throw new RelayError("Reconnect this tab using Connect Temco.", 403);
  const [definitions, user] = await Promise.all([listRelayDefinitions(), prisma.user.findUnique({ where: { id: binding.owner.userId }, select: { isActive: true } })]);
  if (!user?.isActive) throw new RelayError("The Temco account is inactive.", 403);
  if (!binding.owner.sessionId || !await livePasswordSession(binding.owner.sessionId, binding.owner.userId)) throw new RelayError("The Temco session expired or was revoked. Sign in and reconnect.", 403);
  const definition = resolveRelayDefinition(definitions, binding.origin, binding.pathname);
  if (definition.id !== binding.relayId || definition.revision !== binding.relayRevision) throw new RelayError("The relay configuration changed. Reconnect this tab; requests were not replayed.", 409);
  return definition;
}
