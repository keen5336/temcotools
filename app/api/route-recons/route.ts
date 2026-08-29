import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  PickWaveValidationError,
  type PickWaveWorkbookBuffer,
} from "@/lib/pick-waves";
import {
  createRouteRecon,
  RouteReconValidationError,
} from "@/lib/route-recons";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session.userId) return NextResponse.json({ ok: false, error: "Authentication is required." }, { status: 401 });
  if (!session.isActive) return NextResponse.json({ ok: false, error: "User account is inactive." }, { status: 403 });

  try {
    const formData = await req.formData();
    const name = formData.get("name");
    const upload = formData.get("file");
    if (typeof name !== "string" || !(upload instanceof File) || !upload.size) {
      return NextResponse.json({ ok: false, error: "A name and spreadsheet file are required." }, { status: 400 });
    }

    const routeRecon = await createRouteRecon({
      name,
      filename: upload.name,
      fileBuffer: Buffer.from(await upload.arrayBuffer()) as unknown as PickWaveWorkbookBuffer,
      userId: session.userId,
    });
    return NextResponse.json({ ok: true, routeRecon });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create Route Recon.";
    const expected = error instanceof PickWaveValidationError || error instanceof RouteReconValidationError;
    return NextResponse.json({ ok: false, error: message }, { status: expected ? 400 : 500 });
  }
}
