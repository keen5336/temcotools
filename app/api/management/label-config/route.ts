import { NextRequest, NextResponse } from "next/server";
import { requireManager } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  ensureBuiltInLabelTemplates,
  isLabelTemplateKind,
  validateContentType,
  validatePrinterEndpoint,
} from "@/lib/label-configuration";

export async function GET() {
  await requireManager();
  await ensureBuiltInLabelTemplates();
  const [printers, templates] = await Promise.all([
    prisma.labelPrinter.findMany({ orderBy: { name: "asc" } }),
    prisma.labelTemplate.findMany({ orderBy: [{ kind: "asc" }, { isDefault: "desc" }, { name: "asc" }] }),
  ]);
  return NextResponse.json({ printers, templates });
}

export async function POST(request: NextRequest) {
  const session = await requireManager();
  const body = await request.json().catch(() => null);
  if (!body || (body.resource !== "printer" && body.resource !== "template")) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  if (body.resource === "printer") {
    const name = String(body.name ?? "").trim();
    const endpoint = String(body.endpoint ?? "").trim();
    const contentType = String(body.contentType ?? "text/plain");
    if (!name || !validatePrinterEndpoint(endpoint) || !validateContentType(contentType)) {
      return NextResponse.json({ error: "Name, an HTTP(S) endpoint, and a supported content type are required." }, { status: 400 });
    }
    const printer = await prisma.labelPrinter.create({
      data: { name, endpoint, contentType, createdByUserId: session.userId, updatedByUserId: session.userId },
    });
    return NextResponse.json(printer, { status: 201 });
  }

  const name = String(body.name ?? "").trim();
  const zpl = String(body.zpl ?? "").trim();
  const kind = body.kind;
  if (!name || !zpl || !isLabelTemplateKind(kind)) {
    return NextResponse.json({ error: "Name, workflow, and ZPL are required." }, { status: 400 });
  }
  const template = await prisma.labelTemplate.create({
    data: { name, kind, zpl, createdByUserId: session.userId, updatedByUserId: session.userId },
  });
  return NextResponse.json(template, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const session = await requireManager();
  const body = await request.json().catch(() => null);
  if (!body || !body.id || (body.resource !== "printer" && body.resource !== "template")) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  if (body.resource === "printer") {
    const name = String(body.name ?? "").trim();
    const endpoint = String(body.endpoint ?? "").trim();
    const contentType = String(body.contentType ?? "text/plain");
    if (!name || !validatePrinterEndpoint(endpoint) || !validateContentType(contentType)) {
      return NextResponse.json({ error: "Name, an HTTP(S) endpoint, and a supported content type are required." }, { status: 400 });
    }
    const printer = await prisma.labelPrinter.update({
      where: { id: String(body.id) },
      data: { name, endpoint, contentType, isActive: body.isActive !== false, updatedByUserId: session.userId },
    });
    return NextResponse.json(printer);
  }

  const name = String(body.name ?? "").trim();
  const zpl = String(body.zpl ?? "").trim();
  const kind = body.kind;
  if (!name || !zpl || !isLabelTemplateKind(kind)) {
    return NextResponse.json({ error: "Name, workflow, and ZPL are required." }, { status: 400 });
  }
  const isDefault = body.isDefault === true;
  const isActive = body.isActive !== false;
  const template = await prisma.$transaction(async (tx) => {
    if (isDefault) {
      await tx.labelTemplate.updateMany({ where: { kind, isDefault: true, NOT: { id: String(body.id) } }, data: { isDefault: false } });
    }
    return tx.labelTemplate.update({
      where: { id: String(body.id) },
      data: { name, kind, zpl, isActive, isDefault: isActive && isDefault, updatedByUserId: session.userId },
    });
  });
  return NextResponse.json(template);
}
