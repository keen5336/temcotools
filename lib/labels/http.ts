import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthorizationError } from "@/lib/auth/principal";
import { LabelError } from "./model";
export const labelReply = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });
export function labelFailure(error: unknown) {
  if (error instanceof LabelError || error instanceof AuthorizationError) return labelReply({ error: error.message, code: error instanceof LabelError ? error.code : "forbidden" }, error.status);
  if (error instanceof z.ZodError) return labelReply({ error: "Invalid label workflow, device or issuance input." }, 400);
  return labelReply({ error: "Label service unavailable. Read the original operation receipt before repeating an uncertain action." }, 503);
}
export async function readLabelBody(request: Request): Promise<Record<string, unknown>> {
  const max = 384 * 1024;
  if (Number(request.headers.get("content-length")) > max) throw new LabelError("Label request is too large.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new LabelError("A label request body is required.");
  const parts: string[] = [], decoder = new TextDecoder(); let length = 0;
  try {
    while (true) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.byteLength; if (length > max) { await reader.cancel(); throw new LabelError("Label request is too large.", 413); } parts.push(decoder.decode(chunk.value, { stream: true })); }
    parts.push(decoder.decode());
    const value = JSON.parse(parts.join(""));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch (error) { if (error instanceof LabelError) throw error; throw new LabelError("Enter a valid label request."); }
  finally { reader.releaseLock(); }
}
