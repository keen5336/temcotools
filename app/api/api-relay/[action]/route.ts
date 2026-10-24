import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { apiRelayControl } from "@/lib/api-relay/control";
import { buildDmpRequest, dmpConfig } from "@/lib/api-relay/config";

export const runtime = "nodejs";
export const maxDuration = 150;
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  // Cookie-authenticated control operations must originate in Temco, including
  // pairing approval; cross-site pages cannot silently pair a logged-in user.
  const appOrigin = process.env.API_RELAY_PUBLIC_ORIGIN || process.env.NEXT_PUBLIC_APP_URL || req.nextUrl.origin;
  if (req.headers.get("origin") !== new URL(appOrigin).origin) return reply({ error: "Same-origin request required." }, 403);
  try {
    const session = await getSession();
    const user = session.userId && session.isActive ? await prisma.user.findUnique({ where: { id: session.userId }, select: { id: true, isActive: true } }) : null;
    if (!user?.isActive) return reply({ error: "Sign in to use API relay." }, 401);
    const { action } = await params;
    if (!["status", "pair", "lease", "request", "disconnect"].includes(action)) return reply({ error: "Unknown action." }, 404);
    const config = dmpConfig();
    if (action === "status") {
      const data = session.apiRelaySessionId ? await apiRelayControl("connections", { userId: user.id, sessionId: session.apiRelaySessionId }) : { connections: [] };
      return reply({ ...data, configured: config.configured, origins: config.origins, operations: Object.entries(config.operations).map(([id, op]) => ({ id, label: op.label })) });
    }
    if (action === "lease" && !session.apiRelaySessionId) return reply({ ok: true });
    if (!config.configured || !config.identity) return reply({ error: "Configure DMP origins and its signed-in identity endpoint before pairing." }, 503);
    const raw = await req.text();
    if (Buffer.byteLength(raw) > 160000) return reply({ error: "Request is too large." }, 413);
    const body = raw ? JSON.parse(raw) : {};
    if (!body || typeof body !== "object" || Array.isArray(body)) return reply({ error: "Invalid request." }, 400);
    if (action === "pair") {
      if (!config.origins.includes(body.origin)) return reply({ error: "This DMP site is not configured." }, 400);
      if (!session.apiRelaySessionId) { session.apiRelaySessionId = randomUUID(); await session.save(); }
      return reply(await apiRelayControl("pair", { userId: user.id, sessionId: session.apiRelaySessionId }, { origin: body.origin, identity: config.identity, subjectPath: config.subjectPath }));
    }
    if (!session.apiRelaySessionId) return reply({ error: "Pair a DMP tab first." }, 409);
    const owner = { userId: user.id, sessionId: session.apiRelaySessionId };
    if (action === "lease") return reply(await apiRelayControl("lease", owner));
    if (typeof body.connectionId !== "string" || body.connectionId.length > 100) return reply({ error: "Select a DMP connection." }, 400);
    if (action === "disconnect") return reply(await apiRelayControl("disconnect", owner, { connectionId: body.connectionId }));
    if (typeof body.operation !== "string") return reply({ error: "Select a DMP operation." }, 400);
    const request = buildDmpRequest(body.operation, body.input);
    return reply(await apiRelayControl("request", owner, { connectionId: body.connectionId, request }));
  } catch (error) {
    const status = error && typeof error === "object" && "status" in error ? Number(error.status) : error instanceof TypeError ? 503 : 400;
    return reply({ error: status === 503 ? "API relay service is unavailable." : error instanceof Error ? error.message : "API relay failed." }, status);
  }
}
