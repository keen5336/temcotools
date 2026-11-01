import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/db";
import bcrypt from "bcryptjs";
import { lockCurrentAdmin } from "@/lib/auth/admin-write";
import { AuthorizationError } from "@/lib/auth/principal";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const actor = await requireAdmin();
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  const { username, displayName, pin, role, isActive, revokeSessions } = body as {
    username?: string;
    displayName?: string;
    pin?: string;
    role?: string;
    isActive?: boolean;
    revokeSessions?: boolean;
  };

  if (username !== undefined && (typeof username !== "string" || !username.trim())) {
    return NextResponse.json({ error: "Username cannot be empty." }, { status: 400 });
  }
  if (displayName !== undefined && (typeof displayName !== "string" || !displayName.trim())) {
    return NextResponse.json({ error: "Display name cannot be empty." }, { status: 400 });
  }
  if (pin !== undefined && (typeof pin !== "string" || !/^\d{4,6}$/.test(pin))) {
    return NextResponse.json({ error: "PIN must be 4 to 6 digits." }, { status: 400 });
  }
  if (role !== undefined && role !== "admin" && role !== "manager" && role !== "user") {
    return NextResponse.json({ error: "Invalid role." }, { status: 400 });
  }
  if (isActive !== undefined && typeof isActive !== "boolean") {
    return NextResponse.json({ error: "Active state must be a boolean." }, { status: 400 });
  }
  if (revokeSessions !== undefined && typeof revokeSessions !== "boolean") {
    return NextResponse.json({ error: "Session revocation must be a boolean." }, { status: 400 });
  }

  if (username) {
    const conflict = await prisma.user.findFirst({
      where: { username: username.trim(), NOT: { id } },
    });
    if (conflict) {
      return NextResponse.json({ error: "Username already exists." }, { status: 409 });
    }
  }

  const data: Record<string, unknown> = {};
  if (username !== undefined) data.username = username.trim();
  if (displayName !== undefined) data.displayName = displayName.trim();
  if (pin !== undefined) data.pinHash = await bcrypt.hash(pin, 12);
  if (role !== undefined) data.role = role;
  if (isActive !== undefined) data.isActive = isActive;
  if (username !== undefined || pin !== undefined || role !== undefined || isActive !== undefined || revokeSessions) {
    data.authVersion = { increment: 1 };
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      await lockCurrentAdmin(tx, actor.userId, actor.authVersion!);
      return tx.user.update({
        where: { id },
        data,
        select: {
          id: true,
          username: true,
          displayName: true,
          role: true,
          isActive: true,
          lastLoginAt: true,
          createdAt: true,
        },
      });
    });

    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof AuthorizationError) return NextResponse.json({ error: error.message }, { status: 403 });
    throw error;
  }
}
