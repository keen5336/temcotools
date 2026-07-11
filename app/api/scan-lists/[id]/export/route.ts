import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getScanList, scanListToCsv } from "@/lib/scan-lists";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session.userId || !session.isActive) {
    return NextResponse.json({ ok: false, error: "Authentication is required." }, { status: 401 });
  }

  const { id } = await params;
  const scanList = await getScanList(id);
  if (!scanList) {
    return NextResponse.json({ ok: false, error: "Scan list not found." }, { status: 404 });
  }

  const safeName = scanList.name.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "scan-list";
  return new NextResponse(scanListToCsv(scanList), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safeName}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
