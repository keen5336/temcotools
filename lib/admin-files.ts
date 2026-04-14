import { promises as fs } from "fs";
import path from "path";

export const ADMIN_FILES_ROOT =
  process.env.ADMIN_FILE_MANAGER_ROOT || "/data/admin-files";

export type AdminFileEntry = {
  name: string;
  path: string;
  kind: "file" | "directory";
  size: number;
  modifiedAt: string;
};

export function normalizeRelativePath(input?: string | null) {
  const raw = String(input ?? "").replace(/\\/g, "/").trim();
  const normalized = path.posix.normalize(`/${raw}`).slice(1);
  if (normalized === "." || normalized === "/") return "";
  if (normalized.split("/").some((segment) => segment === "..")) {
    throw new Error("Invalid path.");
  }
  return normalized;
}

export function resolveAdminPath(relativePath = "") {
  const clean = normalizeRelativePath(relativePath);
  const root = path.resolve(/* turbopackIgnore: true */ ADMIN_FILES_ROOT);
  const resolved = path.resolve(root, clean);

  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Invalid path.");
  }

  return { clean, resolved, root };
}

export async function ensureAdminFilesRoot() {
  await fs.mkdir(ADMIN_FILES_ROOT, { recursive: true });
}

export async function listAdminDirectory(relativePath = "") {
  const { clean, resolved } = resolveAdminPath(relativePath);
  await ensureAdminFilesRoot();

  const entries = await fs.readdir(resolved, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Folder not found.");
    }
    throw error;
  });

  const items = await Promise.all(
    entries.map(async (entry): Promise<AdminFileEntry> => {
      const childPath = clean ? `${clean}/${entry.name}` : entry.name;
      const stats = await fs.stat(path.join(resolved, entry.name));
      return {
        name: entry.name,
        path: childPath,
        kind: entry.isDirectory() ? "directory" : "file",
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      };
    })
  );

  return items.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
