import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/auth";
import { PickWaveValidationError } from "@/lib/pick-waves";
import { setPickRoutes } from "@/lib/application/pick-actions";

export const runtime = "nodejs";

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ ok: false, error: "Authentication is required." }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.routeMappings) || !body.routeMappings.every((row: unknown) => row && typeof (row as { routeNumber?: unknown }).routeNumber === "string" && (typeof (row as { stagingLocation?: unknown }).stagingLocation === "string" || (row as { stagingLocation?: unknown }).stagingLocation === null))) {
    return NextResponse.json({ ok: false, error: "Valid route mappings are required." }, { status: 400 });
  }
  try {
    const { id } = await params;
    return NextResponse.json({ ok: true, routeMappings: await setPickRoutes(principal, { id, routeMappings: body.routeMappings }) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Failed to save route mappings." }, { status: error && typeof error === "object" && "status" in error ? Number(error.status) : error instanceof PickWaveValidationError ? 400 : 500 });
  }
}
