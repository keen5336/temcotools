import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { startMarsAuditSession } from "@/lib/mars/audit";

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
  const notes = body && typeof body.notes === "string" ? body.notes : null;

  const auditSession = await startMarsAuditSession({
    userId: session.userId,
    notes,
  });

  return NextResponse.json({ ok: true, auditSession });
}
