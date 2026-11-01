"use client";
import Link from "next/link";
export default function ScanInstructions({ result }: { result: unknown }) {
  if (!result || typeof result !== "object") return null;
  if ("pendingReview" in result) return <p className="alert alert-warning">Observation saved. Office instructions need a fresh review before handling this unit.</p>;
  const instructions = "instructions" in result && Array.isArray(result.instructions) ? result.instructions as { dispositionId: string; unitId: string; instruction: string; action: string; targetLocation: string | null }[] : [];
  if (!instructions.length) return null;
  return <section className="border-2 border-warning rounded-xl bg-warning/10 p-4 space-y-3" aria-live="assertive"><h2 className="text-xl font-bold">Current handling instructions</h2>{instructions.map(instruction => <article key={instruction.dispositionId} className="space-y-2"><p className="font-bold text-lg break-words">{instruction.instruction}</p>{instruction.targetLocation && <p className="text-xl font-bold">Move to {instruction.targetLocation}</p>}<p className="text-sm">Instruction: {instruction.action.replaceAll("_", " ")}. Confirm actual placement separately.</p><Link className="btn btn-warning min-h-12" href={`/tools/office?unitId=${encodeURIComponent(instruction.unitId)}`}>Review / confirm execution</Link></article>)}</section>;
}
