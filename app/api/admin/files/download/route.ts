import { promises as fs } from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { normalizeRelativePath, resolveAdminPath } from "@/lib/admin-files";

export const runtime = "nodejs";

const MIME_TYPES: Record<string, string> = {
  ".csv": "text/csv",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".txt": "text/plain; charset=utf-8",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".zip": "application/zip",
};

export async function GET(req: NextRequest) {
  await requireAdmin();

  try {
    const relativePath = normalizeRelativePath(req.nextUrl.searchParams.get("path"));
    if (!relativePath) {
      return NextResponse.json({ error: "Path is required." }, { status: 400 });
    }

    const { resolved } = resolveAdminPath(relativePath);
    const stats = await fs.stat(resolved);

    if (!stats.isFile()) {
      return NextResponse.json({ error: "Only files can be downloaded." }, { status: 400 });
    }

    const buffer = await fs.readFile(resolved);
    const filename = path.basename(resolved);
    const extension = path.extname(filename).toLowerCase();
    const contentType = MIME_TYPES[extension] || "application/octet-stream";

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(buffer.byteLength),
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Download failed." },
      { status: 400 }
    );
  }
}
