import { timingSafeEqual, createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { validateRelayBinding } from "@/lib/api-relay/definitions";
import { relayBody, relayFailure, relayReply } from "@/lib/api-relay/http";

export async function POST(request: NextRequest) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) return relayReply({ error: "Unavailable." }, 503);
  const expected = Buffer.from(createHash("sha256").update(`temco-api-relay-control-v1:${secret}`).digest("hex"));
  const supplied = Buffer.from(request.headers.get("x-api-relay-key") || "");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return relayReply({ error: "Not found." }, 404);
  try {
    await validateRelayBinding(await relayBody(request));
    return relayReply({ ok: true });
  } catch (error) { return relayFailure(error); }
}
