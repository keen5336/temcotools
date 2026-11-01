import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/auth";
import { PickWaveValidationError, type PickWaveRouteInput } from "@/lib/pick-waves";

import { randomUUID } from "node:crypto";
import { importPickWorkbook } from "@/lib/application/pick-actions";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ ok: false, error: "Authentication is required." }, { status: 401 });

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
    if (upload.size > 16 * 1024 * 1024) return NextResponse.json({ok:false,error:"Workbook exceeds 16 MiB."},{status:413});
    const pickWave = await importPickWorkbook(principal, {
      name, filename: upload.name, contentBase64: Buffer.from(await upload.arrayBuffer()).toString("base64"), routeMappings,
      operationId: typeof formData.get("operationId") === "string" ? formData.get("operationId") : randomUUID(),
    });
    return NextResponse.json({ ok: true, pickWave });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create pick wave.";
    return NextResponse.json({ ok: false, error: message }, { status: error instanceof PickWaveValidationError || error instanceof SyntaxError ? 400 : 500 });
  }
}
