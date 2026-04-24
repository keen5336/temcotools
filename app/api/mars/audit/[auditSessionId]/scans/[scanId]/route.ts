import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { deleteMarsAuditScan } from "@/lib/mars/audit";

export const runtime = "nodejs";

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ auditSessionId: string; scanId: string }> }
) {
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

  try {
    const { auditSessionId, scanId } = await context.params;
    const result = await deleteMarsAuditScan({
      auditSessionId,
      scanId,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete audit scan.";
    const status = message === "Audit scan not found." ? 404 : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
