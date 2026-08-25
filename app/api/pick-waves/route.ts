import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createPickWave, PickWaveValidationError, type PickWaveRouteInput, type PickWaveWorkbookBuffer } from "@/lib/pick-waves";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session.userId) return NextResponse.json({ ok: false, error: "Authentication is required." }, { status: 401 });
  if (!session.isActive) return NextResponse.json({ ok: false, error: "User account is inactive." }, { status: 403 });

  try {
    const formData = await req.formData();
    const name = formData.get("name");
    const upload = formData.get("file");
    const routeMappingsRaw = formData.get("routeMappings");
    if (typeof name !== "string" || !(upload instanceof File) || !upload.size) {
      return NextResponse.json({ ok: false, error: "A name and spreadsheet file are required." }, { status: 400 });
    }
    let routeMappings: PickWaveRouteInput[] = [];
    if (typeof routeMappingsRaw === "string" && routeMappingsRaw) {
      const parsed: unknown = JSON.parse(routeMappingsRaw);
      if (!Array.isArray(parsed) || !parsed.every((row) => row && typeof row.routeNumber === "string" && (typeof row.stagingLocation === "string" || row.stagingLocation === null))) {
        return NextResponse.json({ ok: false, error: "Route mappings are invalid." }, { status: 400 });
      }
      routeMappings = parsed;
    }
    const pickWave = await createPickWave({
      name,
      filename: upload.name,
      fileBuffer: Buffer.from(await upload.arrayBuffer()) as unknown as PickWaveWorkbookBuffer,
      routeMappings,
      userId: session.userId,
    });
    return NextResponse.json({ ok: true, pickWave });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create pick wave.";
    return NextResponse.json({ ok: false, error: message }, { status: error instanceof PickWaveValidationError || error instanceof SyntaxError ? 400 : 500 });
  }
}
