import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { listMarsUnits, parseStagedFilter } from "@/lib/mars/inventory";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
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

  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q");
  const staged = parseStagedFilter(searchParams.get("staged"));
  const page = Number(searchParams.get("page") ?? "1");
  const limit = Number(searchParams.get("limit") ?? "25");

  const result = await listMarsUnits({ q, staged, page, limit });

  return NextResponse.json({ ok: true, ...result });
}
