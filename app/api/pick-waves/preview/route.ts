import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/auth";
import { PickWaveValidationError } from "@/lib/pick-waves";
import { previewPickWorkbook } from "@/lib/application/pick-actions";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ ok: false, error: "Authentication is required." }, { status: 401 });
  try {
    const formData = await req.formData();
    const upload = formData.get("file");
    if (!(upload instanceof File) || !upload.size) return NextResponse.json({ ok: false, error: "A spreadsheet file is required." }, { status: 400 });
    if (upload.size > 16 * 1024 * 1024) return NextResponse.json({ok:false,error:"Workbook exceeds 16 MiB."},{status:413});
    const preview = await previewPickWorkbook(principal, { contentBase64: Buffer.from(await upload.arrayBuffer()).toString("base64") });
    return NextResponse.json({ ok: true, preview });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Failed to read spreadsheet." }, { status: error && typeof error === "object" && "status" in error ? Number(error.status) : error instanceof PickWaveValidationError ? 400 : 500 });
  }
}
