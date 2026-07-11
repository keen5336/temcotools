import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { deleteScanList, setScanListArchived } from "@/lib/scan-lists";

export const runtime = "nodejs";

async function authorize() {
  const session = await getSession();
  if (!session.userId) return { error: "Authentication is required.", status: 401 } as const;
  if (!session.isActive) return { error: "User account is inactive.", status: 403 } as const;
  return { session } as const;
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorize();
  if ("error" in auth) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body.archived !== "boolean") {
    return NextResponse.json({ ok: false, error: "archived must be a boolean." }, { status: 400 });
  }

  try {
    const { id } = await params;
    const scanList = await setScanListArchived(id, body.archived);
    return NextResponse.json({ ok: true, scanList });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update scan list.";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorize();
  if ("error" in auth) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  try {
    const { id } = await params;
    await deleteScanList(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete scan list.";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
