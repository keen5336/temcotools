export function barcodeValues(input: string) {
  if (input.length > 100_000) throw new Error("Barcode input exceeds 100,000 characters.");
  const values = input.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  if (values.length > 200) throw new Error("Generate up to 200 barcodes in one batch.");
  if (values.some(value => value.length > 200 || /[^\x20-\x7e]/.test(value))) throw new Error("Code128 values require 1–200 printable ASCII characters.");
  return values;
}
export const barcodeOptions = (value: string) => ({ bcid: "code128", text: value, scale: 3, height: 12, includetext: true, textxalign: "center" as const, textsize: 10, backgroundcolor: "FFFFFF" });
