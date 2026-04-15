import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { setMarsUnitStaged } from "@/lib/mars/inventory";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ requestNumber: string }> }
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
  if (!body || typeof body.staged !== "boolean") {
    return NextResponse.json(
      { ok: false, error: "Request body must include a boolean staged value." },
      { status: 400 }
    );
  }

  const { requestNumber } = await context.params;
  const unit = await setMarsUnitStaged({
    requestNumber,
    staged: body.staged,
    userId: session.userId,
  });

  if (!unit) {
    return NextResponse.json({ ok: false, error: "MARS unit not found." }, { status: 404 });
  }

  return NextResponse.json({ ok: true, unit });
}
