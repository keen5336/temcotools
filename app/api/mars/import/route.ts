import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  importMarsWorkbook,
  MarsImportValidationError,
  type WorkbookInputBuffer,
} from "@/lib/mars/import";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json(
      { ok: false, error: "Authentication is required." },
      { status: 401 }
    );
  }

  if (!session.isActive) {
    return NextResponse.json({ ok: false, error: "User account is inactive." }, { status: 403 });
  }

  try {
    const formData = await req.formData();
    const upload = formData.get("file") ?? formData.get("files");

    if (!(upload instanceof File) || upload.size === 0) {
      return NextResponse.json(
        { ok: false, error: "A spreadsheet file upload is required." },
        { status: 400 }
      );
    }

    const summary = await importMarsWorkbook({
      filename: upload.name,
      fileBuffer: Buffer.from(await upload.arrayBuffer()) as unknown as WorkbookInputBuffer,
      uploadedByUserId: session.userId,
    });

    return NextResponse.json(summary);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to import the spreadsheet.";
    const status = error instanceof MarsImportValidationError ? 400 : 500;

    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
