import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { FavoriteError, parseFavoriteChange } from "@/lib/tool-favorites";
import { getToolFavorites, saveToolFavorites } from "@/lib/tool-favorites-store";

export const runtime = "nodejs";
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
function failure(error: unknown) {
  if (error instanceof FavoriteError) return reply({ error: error.message }, error.status);
  return reply({ error: "Favorites could not be saved or loaded. Please try again." }, 503);
}

export async function GET() {
  try {
    const session = await getSession();
    if (!session.userId || !session.isActive) return reply({ error: "Sign in to use favorites." }, 401);
    return reply(await getToolFavorites(session.userId));
  } catch (error) { return failure(error); }
}

export async function PATCH(req: NextRequest) {
  const origin = process.env.NEXT_PUBLIC_APP_URL || req.nextUrl.origin;
  if (req.headers.get("origin") !== new URL(origin).origin) return reply({ error: "Same-origin request required." }, 403);
  try {
    const session = await getSession();
    if (!session.userId || !session.isActive) return reply({ error: "Sign in to use favorites." }, 401);
    if (Number(req.headers.get("content-length")) > 4096) return reply({ error: "Favorites update is too large." }, 413);
    const body = await req.json().catch(() => null);
    // The session is the sole source of user identity. Client-supplied user IDs
    // are never used, and tool access is checked against the current DB role.
    return reply(await saveToolFavorites(session.userId, parseFavoriteChange(body)));
  } catch (error) { return failure(error); }
}
