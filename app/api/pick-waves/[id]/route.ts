import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { setPickWaveArchived } from "@/lib/pick-waves";

export const runtime = "nodejs";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session.userId) return NextResponse.json({ ok: false, error: "Authentication is required." }, { status: 401 });
  if (!session.isActive) return NextResponse.json({ ok: false, error: "User account is inactive." }, { status: 403 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body.archived !== "boolean") return NextResponse.json({ ok: false, error: "archived must be a boolean." }, { status: 400 });
  try {
    const { id } = await params;
    return NextResponse.json({ ok: true, pickWave: await setPickWaveArchived(id, body.archived) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Failed to update pick wave." }, { status: 400 });
  }
}
