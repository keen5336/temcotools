import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { recordMarsUnitSighting } from "@/lib/mars/audit";

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

  const body = await req.json().catch(() => null);
  if (!body || typeof body.requestNumber !== "string") {
    return NextResponse.json(
      { ok: false, error: "requestNumber is required." },
      { status: 400 }
    );
  }

  try {
    const result = await recordMarsUnitSighting({
      requestNumber: body.requestNumber,
      userId: session.userId,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to record item sighting.";
    const status = message === "MARS unit not found in the current import." ? 404 : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
