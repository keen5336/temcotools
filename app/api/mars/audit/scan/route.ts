import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { recordMarsAuditScan } from "@/lib/mars/audit";

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
    typeof body.auditSessionId !== "string" ||
    typeof body.scannedValue !== "string"
  ) {
    return NextResponse.json(
      { ok: false, error: "auditSessionId and scannedValue are required." },
      { status: 400 }
    );
  }

  try {
    const result = await recordMarsAuditScan({
      auditSessionId: body.auditSessionId,
      scannedValue: body.scannedValue,
      userId: session.userId,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to record audit scan.";
    const status =
      message === "Audit session not found."
        ? 404
        : message === "Audit session is already completed."
          ? 409
          : 400;

    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
