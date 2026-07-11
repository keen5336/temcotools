import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { PickWaveValidationError, scanPickWave } from "@/lib/pick-waves";

export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session.userId) return NextResponse.json({ ok: false, error: "Authentication is required." }, { status: 401 });
  if (!session.isActive) return NextResponse.json({ ok: false, error: "User account is inactive." }, { status: 403 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body.scannedValue !== "string") return NextResponse.json({ ok: false, error: "A scanned value is required." }, { status: 400 });
  try {
    const { id } = await params;
    return NextResponse.json({ ok: true, result: await scanPickWave({ id, scannedValue: body.scannedValue, userId: session.userId }) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Failed to scan pick wave." }, { status: error instanceof PickWaveValidationError ? 400 : 500 });
  }
}
