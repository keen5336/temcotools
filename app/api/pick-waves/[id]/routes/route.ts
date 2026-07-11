import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { PickWaveValidationError, replacePickWaveRoutes } from "@/lib/pick-waves";

export const runtime = "nodejs";

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session.userId) return NextResponse.json({ ok: false, error: "Authentication is required." }, { status: 401 });
  if (!session.isActive) return NextResponse.json({ ok: false, error: "User account is inactive." }, { status: 403 });
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.routeMappings) || !body.routeMappings.every((row: unknown) => row && typeof (row as { routeNumber?: unknown }).routeNumber === "string" && typeof (row as { stagingLocation?: unknown }).stagingLocation === "string")) {
    return NextResponse.json({ ok: false, error: "Valid route mappings are required." }, { status: 400 });
  }
  try {
    const { id } = await params;
    return NextResponse.json({ ok: true, routeMappings: await replacePickWaveRoutes(id, body.routeMappings) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Failed to save route mappings." }, { status: error instanceof PickWaveValidationError ? 400 : 500 });
  }
}
