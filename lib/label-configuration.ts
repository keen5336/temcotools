import { prisma } from "@/lib/db";
import { DEFAULT_TEMPLATE_NAME, DEFAULT_TEMPLATE_ZPL } from "@/app/tools/rtv-label/marsLabelShared";
import { DEFAULT_PICK_WAVE_TEMPLATE } from "@/components/pick-waves/pickWaveLabel";

export const LABEL_TEMPLATE_KINDS = ["mars_return", "pick_wave"] as const;
export type LabelTemplateKindValue = (typeof LABEL_TEMPLATE_KINDS)[number];

export function isLabelTemplateKind(value: unknown): value is LabelTemplateKindValue {
  return LABEL_TEMPLATE_KINDS.includes(value as LabelTemplateKindValue);
}

export async function ensureBuiltInLabelTemplates() {
  await prisma.$transaction([
    prisma.labelTemplate.upsert({
      where: { kind_name: { kind: "mars_return", name: DEFAULT_TEMPLATE_NAME } },
      create: {
        name: DEFAULT_TEMPLATE_NAME,
        kind: "mars_return",
        zpl: DEFAULT_TEMPLATE_ZPL,
        isDefault: true,
      },
      update: {},
    }),
    prisma.labelTemplate.upsert({
      where: { kind_name: { kind: "pick_wave", name: "Default Pick Wave 4x3" } },
      create: {
        name: "Default Pick Wave 4x3",
        kind: "pick_wave",
        zpl: DEFAULT_PICK_WAVE_TEMPLATE,
        isDefault: true,
      },
      update: {},
    }),
  ]);
}

export function validatePrinterEndpoint(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function validateContentType(value: string) {
  return value === "text/plain" || value === "application/octet-stream";
}
