import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { parsePickWaveWorkbook, PickWaveValidationError, type PickWaveWorkbookBuffer } from "@/lib/pick-waves";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session.userId) return NextResponse.json({ ok: false, error: "Authentication is required." }, { status: 401 });
  if (!session.isActive) return NextResponse.json({ ok: false, error: "User account is inactive." }, { status: 403 });
  try {
    const formData = await req.formData();
    const upload = formData.get("file");
    if (!(upload instanceof File) || !upload.size) return NextResponse.json({ ok: false, error: "A spreadsheet file is required." }, { status: 400 });
    const parsed = await parsePickWaveWorkbook(Buffer.from(await upload.arrayBuffer()) as unknown as PickWaveWorkbookBuffer);
    const routeNumbers = [...new Set(parsed.items.map((item) => item.routeNumber).filter((route): route is string => Boolean(route)))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return NextResponse.json({ ok: true, preview: { itemCount: parsed.items.length, routeNumbers, missingColumns: parsed.missingColumns } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Failed to read spreadsheet." }, { status: error instanceof PickWaveValidationError ? 400 : 500 });
  }
}
