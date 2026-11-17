import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { addPickWaveLocation, listPickWaveLocations, removePickWaveLocation } from "@/lib/pick-wave-locations";
import { PickWaveValidationError } from "@/lib/pick-wave-validation";

export const runtime = "nodejs";

async function handle(request?: NextRequest, remove = false) {
  const session = await getSession();
  if (!session.userId) return NextResponse.json({ ok: false, error: "Authentication is required." }, { status: 401 });
  if (!session.isActive) return NextResponse.json({ ok: false, error: "User account is inactive." }, { status: 403 });
  try {
    const body = request ? await request.json().catch(() => null) : null;
    const locations = request
      ? await (remove ? removePickWaveLocation(body?.name) : addPickWaveLocation(body?.name))
      : await listPickWaveLocations();
    return NextResponse.json({ ok: true, locations }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof PickWaveValidationError ? error.message : "Unable to update locations. Refresh the list before trying again." }, { status: error instanceof PickWaveValidationError ? 400 : 500 });
  }
}

export async function GET() { return handle(); }
export async function POST(request: NextRequest) { return handle(request); }
export async function DELETE(request: NextRequest) { return handle(request, true); }
