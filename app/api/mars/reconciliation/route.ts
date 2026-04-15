import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getMarsReconciliation } from "@/lib/mars/reconciliation";

export const runtime = "nodejs";

export async function GET() {
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

  const result = await getMarsReconciliation();
  return NextResponse.json({ ok: true, ...result });
}
