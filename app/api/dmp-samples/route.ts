import { z } from "zod";
import { getCurrentPrincipal } from "@/lib/auth";
import { AuthorizationError } from "@/lib/auth/principal";
import { DmpSampleError, getDmpSampleRouteContext, inspectDmpSample, listDmpSamples, removeDmpSample, saveDmpSample } from "@/lib/dmp-samples";

export const runtime = "nodejs";
const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
const inputSchema = z.object({ action: z.enum(["list", "save", "inspect", "remove", "routeContext"]), input: z.unknown().default({}) }).strict();
export async function POST(request: Request) {
  const principal = await getCurrentPrincipal();
  if (!principal) return reply({ error: "Sign in to use your private source samples." }, 401);
  try {
    // JSON escaping may expand a two-MiB UTF-8 body; bound the actual wire too.
    const reader = request.body?.getReader(); if (!reader) throw new DmpSampleError("Choose a sample action.");
    let size = 0; const chunks: Uint8Array[] = [];
    try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 12 * 1024 * 1024 + 8192) { await reader.cancel(); throw new DmpSampleError("Sample request exceeds its bounded upload limit.", 413); } chunks.push(part.value); } } finally { reader.releaseLock(); }
    let raw: unknown; try { raw = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new DmpSampleError("Use a valid sample action."); }
    const { action, input } = inputSchema.parse(raw);
    const commands = { list: listDmpSamples, save: saveDmpSample, inspect: inspectDmpSample, remove: removeDmpSample, routeContext: getDmpSampleRouteContext };
    return reply(await commands[action](principal, input));
  } catch (error) {
    if (error instanceof AuthorizationError) return reply({ error: error.message }, 403);
    if (error instanceof z.ZodError) return reply({ error: error.issues[0]?.message ?? "Invalid sample action." }, 400);
    const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 500;
    return reply({ error: status < 500 && error instanceof Error ? error.message : "Sample action unavailable. Keep the original operation ID and inspect its receipt before another save." }, status >= 400 && status < 600 ? status : 500);
  }
}
