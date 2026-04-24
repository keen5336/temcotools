import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { generateMarsAuditReport } from "@/lib/mars/audit";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ auditSessionId: string }> }
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

  const body = await req.json().catch(() => null);

  try {
    const { auditSessionId } = await context.params;
    const result = await generateMarsAuditReport({
      auditSessionId,
      userId: session.userId,
      label: body && typeof body.label === "string" ? body.label : null,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to generate audit report.";
    const status = message === "Audit session not found." ? 404 : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
