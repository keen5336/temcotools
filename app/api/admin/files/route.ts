import { promises as fs } from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import {
  ensureAdminFilesRoot,
  listAdminDirectory,
  normalizeRelativePath,
  resolveAdminPath,
} from "@/lib/admin-files";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  await requireAdmin();
  const requestedPath = req.nextUrl.searchParams.get("path") ?? "";

  try {
    const currentPath = normalizeRelativePath(requestedPath);
    const entries = await listAdminDirectory(currentPath);
    const parentPath = currentPath.includes("/")
      ? currentPath.split("/").slice(0, -1).join("/")
      : "";

    return NextResponse.json({ currentPath, parentPath, entries });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list files." },
      { status: 400 }
    );
  }
}

export async function POST(req: NextRequest) {
  await requireAdmin();
  await ensureAdminFilesRoot();

  try {
    const formData = await req.formData();
    const currentPath = normalizeRelativePath(String(formData.get("path") ?? ""));
    const { resolved } = resolveAdminPath(currentPath);
    await fs.mkdir(resolved, { recursive: true });

    const uploads = formData
      .getAll("files")
      .filter((value): value is File => value instanceof File && value.size > 0);

    if (!uploads.length) {
      return NextResponse.json({ error: "No files selected." }, { status: 400 });
    }

    for (const upload of uploads) {
      const safeName = path.basename(upload.name);
      const target = path.join(resolved, safeName);
      const buffer = Buffer.from(await upload.arrayBuffer());
      await fs.writeFile(target, buffer);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed." },
      { status: 400 }
    );
  }
}

export async function PUT(req: NextRequest) {
  await requireAdmin();
  await ensureAdminFilesRoot();

  try {
    const body = (await req.json()) as { path?: string; folderName?: string };
    const currentPath = normalizeRelativePath(body.path);
    const folderName = path.basename(String(body.folderName ?? "").trim());

    if (!folderName || folderName === "." || folderName === "..") {
      return NextResponse.json({ error: "Folder name is required." }, { status: 400 });
    }

    const { resolved } = resolveAdminPath(
      currentPath ? `${currentPath}/${folderName}` : folderName
    );
    await fs.mkdir(resolved, { recursive: true });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Folder creation failed." },
      { status: 400 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  await requireAdmin();

  try {
    const targetPath = normalizeRelativePath(req.nextUrl.searchParams.get("path"));
    if (!targetPath) {
      return NextResponse.json({ error: "Path is required." }, { status: 400 });
    }

    const { resolved } = resolveAdminPath(targetPath);
    await fs.rm(resolved, { recursive: true, force: true });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Delete failed." },
      { status: 400 }
    );
  }
}

