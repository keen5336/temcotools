import { templateSchema } from "./templates";
import { getDefaultProgram } from "./program";
import { PAPERWORK_ASSETS } from "@/scripts/driver-paperwork/assets.mjs";

export function buildDriverPaperworkPayload(template: unknown, program = getDefaultProgram()) {
  const config = templateSchema.parse(template);
  return `(() => { 'use strict';\n${program}\ncreateDriverPaperworkRuntime(${JSON.stringify(config).replace(/</g, "\\u003c")}, ${JSON.stringify(PAPERWORK_ASSETS)}).mount();\n})();`;
}
