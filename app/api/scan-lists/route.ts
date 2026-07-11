import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { saveScanList } from "@/lib/scan-lists";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ ok: false, error: "Authentication is required." }, { status: 401 });
  }
  if (!session.isActive) {
    return NextResponse.json({ ok: false, error: "User account is inactive." }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (
    !body ||
    typeof body.localDraftId !== "string" ||
    typeof body.name !== "string" ||
    typeof body.createdAt !== "string" ||
    !Array.isArray(body.scans) ||
    !body.scans.every(
      (scan: unknown) =>
        typeof scan === "object" &&
        scan !== null &&
        typeof (scan as { value?: unknown }).value === "string" &&
        typeof (scan as { scannedAt?: unknown }).scannedAt === "string"
    )
  ) {
    return NextResponse.json({ ok: false, error: "A valid local scan list is required." }, { status: 400 });
  }

  try {
    const scanList = await saveScanList({
      localDraftId: body.localDraftId,
      name: body.name,
      createdAt: body.createdAt,
      scans: body.scans,
      userId: session.userId,
    });
    return NextResponse.json({ ok: true, scanList });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create scan list.";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
