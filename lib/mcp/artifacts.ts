import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { OAuthError, mcpConfig } from "./config";
export async function createArtifact(grantId: string, bytes: Buffer, filename: string, contentType: string) {
  if (bytes.length > 50 * 1024 * 1024) throw new OAuthError("invalid_request", "This download exceeds the 50 MB MCP artifact limit. Export it in the browser.");
  const id = randomUUID(), expiresAt = new Date(Date.now() + 15 * 60_000);
  await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(8110121)`;
    await tx.mcpArtifact.deleteMany({ where: { expiresAt: { lte: new Date() } } });
    const [sizes] = await tx.$queryRaw<{ own: bigint; total: bigint }[]>`SELECT COALESCE(sum(octet_length(bytes)) FILTER (WHERE "grantId"=${grantId}),0)::bigint AS own, COALESCE(sum(octet_length(bytes)),0)::bigint AS total FROM "McpArtifact"`;
    if (Number(sizes.own) + bytes.length > 64 * 1024 * 1024 || Number(sizes.total) + bytes.length > 256 * 1024 * 1024) throw new OAuthError("temporarily_unavailable", "Download storage is full. Let earlier downloads expire or use the browser.", 429);
    await tx.mcpArtifact.create({ data: { id, grantId, filename: filename.slice(0,255), contentType: contentType.slice(0,150), bytes: new Uint8Array(bytes), expiresAt } });
  });
  return { download: { id, uri: `temco://downloads/${id}`, url: `${mcpConfig().issuer}/api/account/mcp/downloads/${id}`, filename, contentType, sizeBytes: bytes.length, expiresAt, readAction: "mcp.artifact" } };
}
export async function artifactChunk(grantId: string, id: string, offset: number, length: number) {
  const value = await prisma.mcpArtifact.findFirst({ where: { id, grantId, expiresAt: { gt: new Date() } } });
  if (!value) throw new OAuthError("invalid_request", "This private download expired or belongs to another client.", 404);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > value.bytes.length || !Number.isSafeInteger(length) || length < 1 || length > 196608) throw new OAuthError("invalid_request", "Invalid download range.");
  const end = Math.min(offset + length, value.bytes.length);
  return { id, filename: value.filename, contentType: value.contentType, sizeBytes: value.bytes.length, offset, dataBase64: Buffer.from(value.bytes.slice(offset, end)).toString("base64"), nextOffset: end < value.bytes.length ? end : null };
}
