import { NextResponse } from "next/server";
import { getIronSession } from "iron-session";
import { cookies } from "next/headers";
import { sessionOptions, type SessionData } from "@/lib/session";
import { revokeApiRelaySession } from "@/lib/api-relay/control";
import { endSession } from "@/lib/auth/identity";

export async function POST() {
  const cookieStore = await cookies();
  const session = await getIronSession<SessionData>(cookieStore, sessionOptions);
  try {
    await revokeApiRelaySession(session);
    await endSession(session);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Signed out on this device. Server session revocation could not be confirmed; review active sessions after reconnecting." }, { status: 503 });
  } finally { session.destroy(); }
}
