import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ensureBuiltInLabelTemplates, isLabelTemplateKind } from "@/lib/label-configuration";

export async function GET(request: NextRequest) {
  await requireAuth();
  const kind = new URL(request.url).searchParams.get("kind");
  if (!isLabelTemplateKind(kind)) {
    return NextResponse.json({ error: "A valid label workflow is required." }, { status: 400 });
  }

  await ensureBuiltInLabelTemplates();
  const [printers, templates] = await Promise.all([
    prisma.labelPrinter.findMany({
      where: { isActive: true },
      select: { id: true, name: true, endpoint: true, contentType: true },
      orderBy: { name: "asc" },
    }),
    prisma.labelTemplate.findMany({
      where: { kind, isActive: true },
      select: { id: true, name: true, zpl: true, isDefault: true },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    }),
  ]);

  return NextResponse.json({ printers, templates });
}
