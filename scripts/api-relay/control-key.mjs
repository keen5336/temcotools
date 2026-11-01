import { createHash } from "node:crypto";

// Optional isolation for a separately authorized pilot. An unset audience keeps
// the existing production key byte-for-byte; a pilot key cannot control it.
export function controlKey(secret, audience = process.env.API_RELAY_AUDIENCE || "") {
  if (!secret || secret.length < 32) throw new Error("API relay requires a SESSION_SECRET of at least 32 characters.");
  if (typeof audience !== "string" || (audience && !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(audience))) throw new Error("API_RELAY_AUDIENCE must be a bounded nonsecret identifier.");
  const material = audience ? `temco-api-relay-control-v2:${JSON.stringify([audience, secret])}` : `temco-api-relay-control-v1:${secret}`;
  return createHash("sha256").update(material).digest("hex");
}
