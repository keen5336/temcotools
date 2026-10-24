import { NextResponse } from "next/server";
import { getIronSession } from "iron-session";
import { cookies } from "next/headers";
import { sessionOptions, type SessionData } from "@/lib/session";
import { revokeApiRelaySession } from "@/lib/api-relay/control";

export async function POST() {
  const cookieStore = await cookies();
  const session = await getIronSession<SessionData>(cookieStore, sessionOptions);
  await revokeApiRelaySession(session);
  session.destroy();
  return NextResponse.json({ ok: true });
}
