import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Script } from "node:vm";

export function getDefaultProgram() {
  return readFileSync(join(process.cwd(), "scripts/driver-paperwork/runtime.mjs"), "utf8").replace("export function createDriverPaperworkRuntime", "function createDriverPaperworkRuntime");
}
export function validateProgram(program: unknown): program is string {
  if (typeof program !== "string" || Buffer.byteLength(program) > 180_000 || !/\bfunction\s+createDriverPaperworkRuntime\s*\(/.test(program)) return false;
  try {
    // Compile only. Manager-authored JavaScript is never executed on the server.
    new Script(`(() => { 'use strict';\n${program}\n})()`);
    return true;
  } catch { return false; }
}
