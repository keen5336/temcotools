import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import type { Principal } from "@/lib/auth/principal";
import { AuthorizationError } from "@/lib/auth/principal";
import { assertCurrentPrincipal } from "@/lib/auth/identity";
import { ADMIN_FILES_ROOT, AdminFileError, adminEntryFingerprint, listAdminDirectory, MAX_ADMIN_ENTRIES, MAX_ADMIN_FILE_BYTES, MAX_ADMIN_UPLOAD_BYTES, normalizeRelativePath, readAdminFileBytes, secureAdminPath, validateAdminFileName } from "@/lib/admin-files";
import { fingerprint } from "@/lib/labels/model";

const operationId = z.string().min(16).max(100), relative = z.string().max(2048).default("").transform(normalizeRelativePath);
const expected = z.string().regex(/^[a-f0-9]{64}$/), optionalExpected = expected.optional();
const MIME_TYPES: Record<string, string> = { ".csv": "text/csv", ".json": "application/json", ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".txt": "text/plain; charset=utf-8", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xls": "application/vnd.ms-excel", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".zip": "application/zip" };
type Metadata = Record<string, unknown>;
type FileOperationReceipt = { ok: boolean; operationId: string; status: "completed" | "unknown" | "not_applied"; result?: Metadata; error?: string };
async function audit(tx: Prisma.TransactionClient, principal: Principal, action: string, reason: Metadata, sourceHash?: string) { await tx.identityAudit.create({ data: { action: `files.${action}`, actorUserId: principal.userId, sessionId: principal.sessionId, sourceHash, reason: JSON.stringify({ ...reason, grantId: principal.grantId ?? null }) } }); }
function parseMetadata(value: string | null): Metadata { try { return JSON.parse(value ?? "{}"); } catch { throw new AdminFileError("The original operation receipt is unavailable. Inspect the folder before a new operation.", 409, "unknown_effect"); } }
async function checkFingerprint(filename: string, expectedValue?: string) {
  const stats = await fs.lstat(filename);
  if (stats.isSymbolicLink() || (!stats.isDirectory() && (!stats.isFile() || stats.nlink !== 1))) throw new AdminFileError("Symbolic links, multiple hard links and special files are unavailable.", 409, "unsafe_path");
  if (expectedValue && adminEntryFingerprint(stats) !== expectedValue) throw new AdminFileError("The file or folder changed. Reload before continuing.", 409, "stale_file");
  return stats;
}
async function checkTree(filename: string, counter = { value: 0 }) {
  if (++counter.value > MAX_ADMIN_ENTRIES) throw new AdminFileError("This operation exceeds 5,000 filesystem entries. Use smaller folders.", 413);
  const stats = await checkFingerprint(filename);
  if (stats.isDirectory()) for (const child of await fs.readdir(filename)) await checkTree(path.join(filename, child), counter);
}
function decodeUpload(contentBase64: string) {
  if (contentBase64.length > Math.ceil(MAX_ADMIN_FILE_BYTES / 3) * 4 || contentBase64.length % 4 || /[^A-Za-z0-9+/=]/.test(contentBase64)) throw new AdminFileError("Upload content must be valid base64 within the 64 MiB file limit.", 413);
  const bytes = Buffer.from(contentBase64, "base64");
  if (bytes.length > MAX_ADMIN_FILE_BYTES || bytes.toString("base64") !== contentBase64) throw new AdminFileError("Upload content is invalid or exceeds 64 MiB.", 413);
  return bytes;
}

// The root is application configuration, never an action argument. A factory
// gives integration tests an isolated synthetic root without touching user files.
export function createAdminFileCommands(configuredRoot = ADMIN_FILES_ROOT) {
  const root = path.resolve(/* turbopackIgnore: true */ configuredRoot);
  async function read<T>(principal: Principal, action: string, input: Metadata, run: () => Promise<T>) {
    return prisma.$transaction(async tx => { const current = await assertCurrentPrincipal(tx, principal, "files.manage"); await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`admin-files-root:${root}`}, 813))`; const result = await run(); await audit(tx, current, action, input); return result; }, { timeout: 30_000 });
  }
  async function mutate(principal: Principal, action: string, id: string, input: Metadata, run: (dispatch: () => void) => Promise<Metadata>): Promise<FileOperationReceipt> {
    const inputFingerprint = fingerprint({ action, input }), sourceHash = createHash("sha256").update(`files:${principal.userId}:${id}`).digest("hex");
    const prior = await prisma.$transaction(async tx => {
      const current = await assertCurrentPrincipal(tx, principal, "files.manage");
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`admin-files-operation:${sourceHash}`}, 813))`;
      const started = await tx.identityAudit.findFirst({ where: { sourceHash, action: "files.operation_started" }, orderBy: { createdAt: "asc" } });
      if (started) {
        if (parseMetadata(started.reason).inputFingerprint !== inputFingerprint) throw new AdminFileError("This operation ID belongs to different file inputs.", 409, "idempotency_conflict");
        const settled = await tx.identityAudit.findFirst({ where: { sourceHash, action: { in: ["files.operation_completed", "files.operation_unknown", "files.operation_not_applied"] } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
        return settled ? parseMetadata(settled.reason).receipt as FileOperationReceipt : { ok: false, operationId: id, status: "unknown" as const, error: "This file operation is in progress or its result is uncertain. Inspect it before a new operation; it was not replayed." };
      }
      await audit(tx, current, "operation_started", { operationId: id, action, inputFingerprint, input }, sourceHash);
      return null;
    });
    if (prior) return prior;
    let effectStarted = false;
    try {
      return await prisma.$transaction(async tx => {
        const current = await assertCurrentPrincipal(tx, principal, "files.manage");
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`admin-files-root:${root}`}, 813))`;
        const result = await run(() => { effectStarted = true; });
        const receipt: FileOperationReceipt = { ok: true, operationId: id, status: "completed", result };
        await audit(tx, current, "operation_completed", { operationId: id, action, receipt }, sourceHash);
        return receipt;
      }, { timeout: 30_000 });
    } catch (error) {
      const receipt: FileOperationReceipt = { ok: false, operationId: id, status: effectStarted ? "unknown" : "not_applied", error: effectStarted ? "The operation result is uncertain. Inspect the folder before any new operation; no automatic retry will occur." : error instanceof AdminFileError || error instanceof AuthorizationError ? error.message : "The file operation could not start." };
      // Persisting this best-effort result cannot turn an unknown filesystem
      // effect into a known failure. The durable started event prevents replay.
      await prisma.$transaction(tx => audit(tx, principal, effectStarted ? "operation_unknown" : "operation_not_applied", { operationId: id, action, receipt }, sourceHash)).catch(() => undefined);
      return receipt;
    }
  }
  async function listAdminFiles(principal: Principal, input: unknown = {}) {
    const data = z.object({ path: relative }).parse(input);
    return read(principal, "listed", { path: data.path }, async () => ({ currentPath: data.path, parentPath: data.path.split("/").slice(0, -1).join("/"), entries: await listAdminDirectory(data.path, root) }));
  }
  async function downloadAdminFile(principal: Principal, input: unknown) {
    const data = z.object({ path: relative }).parse(input);
    return read(principal, "downloaded", { path: data.path }, async () => { const file = await readAdminFileBytes(data.path, root); return { filename: file.filename, contentType: MIME_TYPES[path.extname(file.filename).toLowerCase()] ?? "application/octet-stream", size: file.bytes.length, fingerprint: file.fingerprint, contentBase64: file.bytes.toString("base64") }; });
  }
  async function uploadAdminFiles(principal: Principal, input: unknown) {
    const data = z.object({ operationId, path: relative, files: z.array(z.object({ name: z.string().transform(validateAdminFileName), contentBase64: z.string(), replace: z.boolean().default(false), expectedFingerprint: optionalExpected })).min(1).max(40) }).parse(input);
    const files = data.files.map(file => ({ ...file, bytes: decodeUpload(file.contentBase64) }));
    if (new Set(files.map(file => file.name)).size !== files.length) throw new AdminFileError("Each upload must have a distinct filename.");
    if (files.reduce((sum, file) => sum + file.bytes.length, 0) > MAX_ADMIN_UPLOAD_BYTES) throw new AdminFileError("The upload batch exceeds 128 MiB.", 413);
    const metadata = { path: data.path, files: files.map(file => ({ name: file.name, size: file.bytes.length, hash: createHash("sha256").update(file.bytes).digest("hex"), replace: file.replace, expectedFingerprint: file.expectedFingerprint ?? null })) };
    return mutate(principal, "upload", data.operationId, metadata, async dispatch => {
      const directory = await secureAdminPath(data.path, root); if (!(await fs.lstat(directory.resolved)).isDirectory()) throw new AdminFileError("Choose an existing destination folder.");
      const targets = [];
      for (const file of files) {
        const target = await secureAdminPath(data.path ? `${data.path}/${file.name}` : file.name, root, true);
        if (target.exists) { if (!file.replace || !file.expectedFingerprint) throw new AdminFileError("A filename already exists. Explicitly authorize replacement of its current version.", 409, "file_exists"); const stats = await checkFingerprint(target.resolved, file.expectedFingerprint); if (!stats.isFile()) throw new AdminFileError("An upload cannot replace a folder.", 409); }
        else if (file.replace || file.expectedFingerprint) throw new AdminFileError("The replacement target changed. Reload the folder.", 409, "stale_file");
        targets.push({ ...target, file });
      }
      for (const target of targets) {
        const temporary = path.join(directory.resolved, `.temco-upload-${randomUUID()}`);
        dispatch();
        const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(target.file.bytes); await handle.sync(); } finally { await handle.close(); }
        try { if (target.exists) { await checkFingerprint(target.resolved, target.file.expectedFingerprint); await fs.rename(temporary, target.resolved); } else { await fs.link(temporary, target.resolved); await fs.unlink(temporary); } }
        catch (error) { await fs.unlink(temporary).catch(() => undefined); throw error; }
      }
      return { uploaded: files.map(file => ({ name: file.name, size: file.bytes.length })) };
    });
  }
  async function createAdminDirectory(principal: Principal, input: unknown) {
    const data = z.object({ operationId, path: relative, folderName: z.string().transform(validateAdminFileName) }).parse(input);
    return mutate(principal, "mkdir", data.operationId, data, async dispatch => { const target = await secureAdminPath(data.path ? `${data.path}/${data.folderName}` : data.folderName, root, true); if (target.exists) throw new AdminFileError("That file or folder already exists.", 409); dispatch(); await fs.mkdir(target.resolved, { mode: 0o700 }); return { path: target.clean }; });
  }
  async function moveAdminFile(principal: Principal, input: unknown) {
    const data = z.object({ operationId, path: relative, destinationPath: relative, expectedFingerprint: expected }).parse(input);
    if (!data.path || !data.destinationPath || data.path === data.destinationPath || data.destinationPath.startsWith(`${data.path}/`)) throw new AdminFileError("Choose distinct managed source and destination paths outside the source folder.");
    return mutate(principal, "move", data.operationId, data, async dispatch => { const source = await secureAdminPath(data.path, root), target = await secureAdminPath(data.destinationPath, root, true); await checkFingerprint(source.resolved, data.expectedFingerprint); await checkTree(source.resolved); if (target.exists) throw new AdminFileError("Destination already exists. Choose another name or remove it explicitly.", 409, "file_exists"); dispatch(); await fs.rename(source.resolved, target.resolved); return { path: target.clean, previousPath: source.clean }; });
  }
  async function deleteAdminFile(principal: Principal, input: unknown) {
    const data = z.object({ operationId, path: relative, expectedFingerprint: expected }).parse(input);
    if (!data.path) throw new AdminFileError("The managed root cannot be deleted.");
    return mutate(principal, "delete", data.operationId, data, async dispatch => { const source = await secureAdminPath(data.path, root); await checkFingerprint(source.resolved, data.expectedFingerprint); await checkTree(source.resolved); dispatch(); await fs.rm(source.resolved, { recursive: true, force: false }); return { path: source.clean }; });
  }
  return { listAdminFiles, downloadAdminFile, uploadAdminFiles, createAdminDirectory, moveAdminFile, deleteAdminFile };
}
export const { listAdminFiles, downloadAdminFile, uploadAdminFiles, createAdminDirectory, moveAdminFile, deleteAdminFile } = createAdminFileCommands();
