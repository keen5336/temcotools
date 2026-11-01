"use client";
import { useMemo, useState } from "react";
import bwipjs from "bwip-js/browser";
import { barcodeOptions, barcodeValues } from "@/lib/barcodes";

export default function BarcodeGeneratorClient({ printingAllowed = true }: { printingAllowed?: boolean }) {
  const [input, setInput] = useState("");
  const result = useMemo(() => {
    try { return { cards: barcodeValues(input).map(value => ({ value, svg: bwipjs.toSVG(barcodeOptions(value)) })), error: "" }; }
    catch (error) { return { cards: [], error: error instanceof Error ? error.message : "Barcode could not be rendered." }; }
  }, [input]);
  return <div className="flex flex-col lg:flex-row gap-6 items-start"><aside className="w-full lg:w-72 shrink-0 print:hidden"><div className="rounded-xl border bg-base-100 p-4 space-y-4"><h2 className="font-semibold">Barcode values</h2><p className="text-sm">Paste Code128 values, one per line. Up to 200 values per batch.</p><textarea aria-label="Barcode values" className="textarea textarea-bordered font-mono min-h-64 w-full" value={input} maxLength={100_000} onChange={event => setInput(event.target.value)} placeholder={"SYNTHETIC-001\nSYNTHETIC-002"} /><div className="flex gap-2"><button className="btn btn-outline flex-1" onClick={() => setInput("")} disabled={!input}>Clear</button><button className="btn btn-primary flex-1" disabled={!result.cards.length || !printingAllowed} onClick={() => { if (printingAllowed) window.print(); }}>Print</button></div><p className="text-xs">{result.cards.length} barcodes. Printing requires this browser/device; opening the dialog does not confirm physical output.</p></div></aside><div className="flex-1 min-w-0 w-full">{result.error ? <p role="alert" className="alert alert-error">{result.error}</p> : !result.cards.length ? <p className="rounded-xl border border-dashed p-8 text-center opacity-60">Barcodes will appear here</p> : <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">{result.cards.map((card,index) => <article key={`${index}-${card.value}`} className="rounded-xl border bg-base-100 p-4 min-w-0 break-inside-avoid"><p className="font-mono text-xs break-all mb-2">{card.value}</p><div className="bg-white p-2 [&>svg]:w-full [&>svg]:h-auto" dangerouslySetInnerHTML={{__html:card.svg}} /></article>)}</div>}</div></div>;
}
