import { getCurrentPrincipal } from "@/lib/auth";
import { createPrinter, createTemplate, getManagedLabelConfiguration, setDefaultTemplate, setPrinterEnabled, setTemplateEnabled, updatePrinter, updateTemplate } from "@/lib/label-configuration-service";
import { labelFailure, labelReply, readLabelBody } from "@/lib/labels/http";
export const runtime = "nodejs";
export async function GET() {
  try { const principal = await getCurrentPrincipal(); return principal ? labelReply(await getManagedLabelConfiguration(principal)) : labelReply({ error: "Sign in required." }, 401); } catch (error) { return labelFailure(error); }
}
export async function POST(request: Request) {
  try {
    const principal = await getCurrentPrincipal(); if (!principal) return labelReply({ error: "Sign in required." }, 401);
    const body = await readLabelBody(request) as { resource?: string };
    if (body?.resource !== "printer" && body?.resource !== "template") return labelReply({ error: "Choose a printer or template." }, 400);
    return labelReply(await (body.resource === "printer" ? createPrinter(principal, body) : createTemplate(principal, body)), 201);
  } catch (error) { return labelFailure(error); }
}
export async function PATCH(request: Request) {
  try {
    const principal = await getCurrentPrincipal(); if (!principal) return labelReply({ error: "Sign in required." }, 401);
    const body = await readLabelBody(request) as { resource?: string; action?: string };
    if (body?.resource !== "printer" && body?.resource !== "template") return labelReply({ error: "Choose a printer or template." }, 400);
    if (body.action === "enabled") return labelReply(await (body.resource === "printer" ? setPrinterEnabled(principal, body) : setTemplateEnabled(principal, body)));
    if (body.resource === "template" && body.action === "default") return labelReply(await setDefaultTemplate(principal, body));
    return labelReply(await (body.resource === "printer" ? updatePrinter(principal, body) : updateTemplate(principal, body)));
  } catch (error) { return labelFailure(error); }
}
