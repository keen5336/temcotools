import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const ADMIN_FILES_ROOT =
  process.env.ADMIN_FILE_MANAGER_ROOT || "/data/admin-files";

export const MAX_ADMIN_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_ADMIN_UPLOAD_BYTES = 128 * 1024 * 1024;
export const MAX_ADMIN_ENTRIES = 5000;
export class AdminFileError extends Error { constructor(message: string, public status = 400, public code = "invalid_file_action") { super(message); } }
export type AdminFileEntry = {
  name: string;
  path: string;
  kind: "file" | "directory" | "blocked";
  size: number;
  modifiedAt: string;
  fingerprint: string;
  blockedReason?: string;
};

export function normalizeRelativePath(input?: string | null) {
  if (input != null && typeof input !== "string") throw new AdminFileError("A relative path is required.");
  const raw = (input ?? "").replace(/\\/g, "/").trim();
  if (raw.length > 2048 || /[\x00-\x1f\x7f]/.test(raw) || raw.startsWith("/") || /^[a-z]:/i.test(raw) || raw.split("/").some(segment => segment === ".." || segment.length > 240 || (segment.startsWith(".temco-upload-") || segment === ".temco-sites"))) throw new AdminFileError("Use a path within the managed file root without parent traversal or reserved upload names.");
  const clean = path.posix.normalize(raw);
  return clean === "." ? "" : clean.replace(/\/$/, "");
}

export function validateAdminFileName(input: string) {
  if (typeof input !== "string" || !input || input.length > 240 || input !== input.trim() || input === "." || input === ".." || /[/\\\x00-\x1f\x7f]/.test(input) || (input.startsWith(".temco-upload-") || input === ".temco-sites")) throw new AdminFileError("Use a single file or folder name without path separators.");
  return input;
}

export function resolveAdminPath(relativePath = "", configuredRoot = ADMIN_FILES_ROOT) {
  const clean = normalizeRelativePath(relativePath);
  const root = path.resolve(/* turbopackIgnore: true */ configuredRoot);
  const resolved = path.resolve(root, clean);

  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new AdminFileError("Path is outside the managed root.");
  }

  return { clean, resolved, root };
}

export async function ensureAdminFilesRoot(configuredRoot = ADMIN_FILES_ROOT) {
  await fs.mkdir(configuredRoot, { recursive: true });
  return fs.realpath(/* turbopackIgnore: true */ configuredRoot);
}

export async function secureAdminPath(relativePath = "", configuredRoot = ADMIN_FILES_ROOT, allowMissingFinal = false) {
  const root = await ensureAdminFilesRoot(configuredRoot), { clean, resolved } = resolveAdminPath(relativePath, root);
  let cursor = root;
  const parts = clean ? clean.split("/") : [];
  for (let index = 0; index < parts.length; index++) {
    cursor = path.join(cursor, parts[index]);
    let stats;
    try { stats = await fs.lstat(cursor); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissingFinal && index === parts.length - 1) return { clean, root, resolved, exists: false }; throw new AdminFileError("File or folder not found.", 404, "not_found"); }
    if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) throw new AdminFileError("Symbolic links and special files are unavailable.", 409, "unsafe_path");
    if (index < parts.length - 1 && !stats.isDirectory()) throw new AdminFileError("A parent path is not a folder.", 409);
    const real = await fs.realpath(cursor);
    if (real !== root && !real.startsWith(`${root}${path.sep}`)) throw new AdminFileError("Path is outside the managed root.", 409, "unsafe_path");
  }
  return { clean, root, resolved, exists: true };
}

export const adminEntryFingerprint = (stats: { dev: number; ino: number; size: number; mtimeMs: number }) => createHash("sha256").update(`${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`).digest("hex");

export async function readAdminFileBytes(relativePath: string, configuredRoot = ADMIN_FILES_ROOT) {
  const target = await secureAdminPath(relativePath, configuredRoot);
  if (!target.clean) throw new AdminFileError("Choose a file.");
  const handle = await fs.open(target.resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1) throw new AdminFileError("Only ordinary files with a single managed link can be downloaded.", 409, "unsafe_path");
    if (stats.size > MAX_ADMIN_FILE_BYTES) throw new AdminFileError("This file exceeds the managed download limit of 64 MiB.", 413);
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_ADMIN_FILE_BYTES) throw new AdminFileError("This file exceeds the managed download limit of 64 MiB.", 413);
    return { bytes, filename: path.basename(target.resolved), fingerprint: adminEntryFingerprint(stats) };
  } finally { await handle.close(); }
}

export async function listAdminDirectory(relativePath = "", configuredRoot = ADMIN_FILES_ROOT) {
  const { clean, resolved } = await secureAdminPath(relativePath, configuredRoot);

  const entries = await fs.readdir(resolved, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AdminFileError("Folder not found.", 404);
    }
    throw error;
  });

  if (entries.length > MAX_ADMIN_ENTRIES) throw new AdminFileError("This folder exceeds 5,000 entries. Organize it into smaller folders.", 413);
  const items = await Promise.all(
    entries.filter(entry => !entry.name.startsWith(".temco-upload-") && entry.name !== ".temco-sites").map(async (entry): Promise<AdminFileEntry> => {
      const childPath = clean ? `${clean}/${entry.name}` : entry.name;
      const stats = await fs.lstat(path.join(resolved, entry.name));
      const blocked = stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory()) || (stats.isFile() && stats.nlink !== 1);
      return {
        name: entry.name,
        path: childPath,
        kind: blocked ? "blocked" : stats.isDirectory() ? "directory" : "file",
        size: blocked ? 0 : stats.size,
        modifiedAt: stats.mtime.toISOString(),
        fingerprint: adminEntryFingerprint(stats),
        ...(blocked ? { blockedReason: "Symbolic links, multiple hard links and special files are unavailable." } : {}),
      };
    })
  );

  return items.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
