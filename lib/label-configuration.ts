import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { DEFAULT_TEMPLATE_NAME, DEFAULT_TEMPLATE_ZPL } from "@/app/tools/rtv-label/marsLabelShared";
import { DEFAULT_PICK_WAVE_TEMPLATE } from "@/components/pick-waves/pickWaveLabel";

export const LABEL_TEMPLATE_KINDS = ["mars_return", "pick_wave"] as const;
export type LabelTemplateKindValue = (typeof LABEL_TEMPLATE_KINDS)[number];

export function isLabelTemplateKind(value: unknown): value is LabelTemplateKindValue {
  return LABEL_TEMPLATE_KINDS.includes(value as LabelTemplateKindValue);
}

export async function ensureBuiltInLabelTemplates(client?: Prisma.TransactionClient) {
  const ensure = async (tx: Prisma.TransactionClient) => {
    for (const item of [{ kind: "mars_return" as const, name: DEFAULT_TEMPLATE_NAME, zpl: DEFAULT_TEMPLATE_ZPL }, { kind: "pick_wave" as const, name: "Default Pick Wave 4x3", zpl: DEFAULT_PICK_WAVE_TEMPLATE }]) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`legacy-template:${item.kind}`}, 812))`;
      const currentDefault = await tx.labelTemplate.findFirst({ where: { kind: item.kind, isActive: true, isDefault: true }, select: { id: true } });
      if (!await tx.labelTemplate.findFirst({ where: { kind: item.kind, name: item.name } })) await tx.labelTemplate.create({ data: { ...item, isDefault: !currentDefault } });
    }
  };
  if (client) await ensure(client); else await prisma.$transaction(ensure);
}

export function validatePrinterEndpoint(value: string) {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && !url.hash && value.length <= 2048;
  } catch {
    return false;
  }
}

export function validateContentType(value: string) {
  return value === "text/plain" || value === "application/octet-stream";
}
