import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { PickWaveValidationError, savePickWaveScansToList } from "@/lib/pick-waves";

export const runtime = "nodejs";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session.userId) return NextResponse.json({ ok: false, error: "Authentication is required." }, { status: 401 });
  if (!session.isActive) return NextResponse.json({ ok: false, error: "User account is inactive." }, { status: 403 });
  try {
    const { id } = await params;
    return NextResponse.json({ ok: true, scanList: await savePickWaveScansToList(id, session.userId) });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof PickWaveValidationError ? error.message : "Failed to save scan list." },
      { status: error instanceof PickWaveValidationError ? 400 : 500 },
    );
  }
}
