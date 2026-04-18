import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { submitMarsAuditSession } from "@/lib/mars/audit";

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
  if (
    !body ||
    !Array.isArray(body.scans) ||
    !body.scans.every((value: unknown) => typeof value === "string")
  ) {
    return NextResponse.json(
      { ok: false, error: "scans must be an array of strings." },
      { status: 400 }
    );
  }

  try {
    const result = await submitMarsAuditSession({
      scans: body.scans,
      userId: session.userId,
      deviceId: typeof body.deviceId === "string" ? body.deviceId : null,
      localAuditId: typeof body.localAuditId === "string" ? body.localAuditId : null,
      startedAt: typeof body.startedAt === "string" ? body.startedAt : null,
      completedAt: typeof body.completedAt === "string" ? body.completedAt : null,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to submit audit.";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
