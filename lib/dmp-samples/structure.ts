import { SaxesParser } from "saxes";

export const MAX_SAMPLE_BYTES = 2 * 1024 * 1024;
export const SAMPLE_LIMITS = { bytes: MAX_SAMPLE_BYTES, depth: 24, nodes: 50_000, fields: 512, rows: 10_000, attributesPerNode: 64, valueCharacters: 32_768, returnedValues: 20, returnedValueCharacters: 240, routeContextRecords: 10, orderReferences: 20 } as const;
export class DmpSampleError extends Error { constructor(message: string, public status = 400, public code = "invalid_sample") { super(message); } }
export type SampleFormat = "json" | "csv" | "xml";
type Field = { path: string; types: string[]; occurrences: number; distinctValues: number };
type Cell = { path: string; sourcePath: string; type: string; value: string; occurrence: number; truncated: boolean };
export type XmlSourceNode = { elementName: string; sourcePath: string; parentSourcePath: string | null; documentOrder: number; attributes: Record<string, string>; text: string };
export type SampleStructure = { format: SampleFormat; nodes: number; rows: number | null; fields: Field[]; limitations: string };
const unsafeName = /^(?:headers|requestheaders|responseheaders|request|response|har|log|xsrf|pin|pincode|otp|verificationcode|pwd|stkn)$/i;
function name(value: string) {
  const normalized = value.replace(/[^a-z0-9]/gi, "");
  if (!value || value.length > 160 || /[\x00-\x1f\x7f]/.test(value) || unsafeName.test(normalized) || /authorization|cookie|password|passwd|secret|credential|token|apikey|sessionid/i.test(normalized) || ["__proto__", "prototype", "constructor"].includes(value)) throw new DmpSampleError("This sample contains a credential, header, request/package field or unsupported field name. Export the business response body only.");
}
function safeText(value: string) {
  if (/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:file|ftp|javascript|data):|(?:authorization|set-cookie|cookie|password|client_secret|access_token|refresh_token|api[_-]?key|\bstkn)\s*[:=]|\b(?:Authorization|Set-Cookie|X-Api-Key)\b/i.test(value)) throw new DmpSampleError("Credentials, headers, secret-like strings and executable/private URL schemes are not accepted. Use a reviewed body-only export.");
  let count = 0;
  for (const match of value.matchAll(/\bhttps?:\/\/[^\s<>"'\\]+/gi)) {
    if (++count > 5000 || match[0].length > 4096) throw new DmpSampleError("Sample exceeds bounded URL inspection.", 413);
    let url: URL; try { url = new URL(match[0]); } catch { throw new DmpSampleError("A sample URL is malformed; retain a clean business body."); }
    if (url.username || url.password) throw new DmpSampleError("URLs containing credentials/userinfo are not accepted.");
    const secretParameter = (key: string) => /token|secret|password|passwd|credential|apikey|authorization|signature|^sig$|^key$|^auth$|^code$|^session|^stkn$/i.test(key.replace(/[^a-z0-9]/gi, ""));
    if ([...url.searchParams.keys(), ...new URLSearchParams(url.hash.replace(/^#/, "")).keys()].some(secretParameter)) throw new DmpSampleError("URLs containing secret/auth query or fragment parameters are not accepted.");
    // URL parsing is lexical only. Never fetch, resolve DNS or render as a link.
  }
}
const escapePath = (value: string) => value.replace(/~/g, "~0").replace(/\//g, "~1");
const childPath = (parent: string, key: string) => `${parent}/${escapePath(key)}`;

// No network, DOM evaluation, filesystem access or source-specific field mapping.
// Values remain private and leave this parser only after an explicit field query.
export function inspectSampleBody(format: SampleFormat, body: string, query?: { fieldPath: string; offset?: number; limit?: number }, onXmlNode?: (node: XmlSourceNode) => void) {
  if (Buffer.byteLength(body, "utf8") > MAX_SAMPLE_BYTES) throw new DmpSampleError("Sample bodies are limited to 2 MiB.", 413);
  if (!body.trim() || body.includes("\0") || body.includes("\ufffd")) throw new DmpSampleError("Choose a nonempty UTF-8 business response body.");
  safeText(body);
  const fields = new Map<string, { types: Set<string>; count: number; distinct: Set<string> }>();
  const selected: Cell[] = []; let selectedCount = 0, nodes = 0, rows: number | null = null;
  const offset = query?.offset ?? 0, limit = query?.limit ?? SAMPLE_LIMITS.returnedValues;
  if (offset < 0 || !Number.isInteger(offset) || offset > SAMPLE_LIMITS.nodes || limit < 1 || limit > SAMPLE_LIMITS.returnedValues || !Number.isInteger(limit)) throw new DmpSampleError("Choose a bounded value page.");
  function visit(path: string, type: string, value?: string, sourcePath = path) {
    if (++nodes > SAMPLE_LIMITS.nodes || path.length > 1200 || sourcePath.length > 1600) throw new DmpSampleError("Sample exceeds the bounded node/path limit.", 413);
    let field = fields.get(path);
    if (!field) { if (fields.size >= SAMPLE_LIMITS.fields) throw new DmpSampleError("Sample has too many distinct field paths.", 413); field = { types: new Set(), count: 0, distinct: new Set() }; fields.set(path, field); }
    field.types.add(type); field.count++;
    if (value !== undefined) {
      if (value.length > SAMPLE_LIMITS.valueCharacters) throw new DmpSampleError("A field exceeds the bounded text limit.", 413);
      safeText(value); field.distinct.add(value);
      if (query?.fieldPath === path) {
        if (selectedCount >= offset && selected.length < limit) selected.push({ path, sourcePath, type, value: value.slice(0, SAMPLE_LIMITS.returnedValueCharacters), occurrence: selectedCount, truncated: value.length > SAMPLE_LIMITS.returnedValueCharacters });
        selectedCount++;
      }
    }
  }
  if (format === "json") {
    let parsed: unknown; try { parsed = JSON.parse(body); } catch { throw new DmpSampleError("Use valid JSON containing only the response body."); }
    if (!parsed || typeof parsed !== "object") throw new DmpSampleError("A JSON object or array body is required.");
    function walk(value: unknown, path: string, depth: number, sourcePath = path) {
      if (depth > SAMPLE_LIMITS.depth) throw new DmpSampleError("Sample nesting exceeds 24 levels.", 413);
      if (Array.isArray(value)) {
        if (value.length > SAMPLE_LIMITS.rows) throw new DmpSampleError("A sample array exceeds 10,000 entries.", 413);
        if (depth === 0) rows = value.length;
        visit(path || "/", "array", undefined, sourcePath || "/"); value.forEach((item, index) => walk(item, childPath(path, "*"), depth + 1, childPath(sourcePath, String(index))));
      } else if (value !== null && typeof value === "object") {
        visit(path || "/", "object", undefined, sourcePath || "/"); for (const [key, item] of Object.entries(value)) { name(key); walk(item, childPath(path, key), depth + 1, childPath(sourcePath, key)); }
      } else visit(path || "/", value === null ? "null" : typeof value, value === null ? "null" : String(value), sourcePath || "/");
    }
    walk(parsed, "", 0);
  } else if (format === "csv") {
    const records: string[][] = []; let record: string[] = [], cell = "", quoted = false, closed = false;
    function pushCell() { if (cell.length > SAMPLE_LIMITS.valueCharacters || record.length >= 256) throw new DmpSampleError("CSV exceeds its field/text limit.", 413); record.push(cell); cell = ""; closed = false; }
    function pushRow() { pushCell(); if (records.length > SAMPLE_LIMITS.rows) throw new DmpSampleError("CSV exceeds 10,000 data rows.", 413); records.push(record); record = []; }
    for (let index = 0; index < body.length; index++) {
      const c = body[index];
      if (quoted) { if (c === '"' && body[index + 1] === '"') { cell += '"'; index++; } else if (c === '"') { quoted = false; closed = true; } else cell += c; }
      else if (c === '"') { if (cell || closed) throw new DmpSampleError("CSV quoting is invalid."); quoted = true; }
      else if (c === ",") pushCell();
      else if (c === "\n" || c === "\r") { if (c === "\r" && body[index + 1] === "\n") index++; pushRow(); }
      else { if (closed) throw new DmpSampleError("CSV has characters after a quoted field."); cell += c; }
      if (cell.length > SAMPLE_LIMITS.valueCharacters) throw new DmpSampleError("CSV field text is too large.", 413);
    }
    if (quoted) throw new DmpSampleError("CSV has an unclosed quoted field.");
    if (cell || record.length || closed) pushRow();
    if (!records.length) throw new DmpSampleError("CSV needs a header row.");
    const headers = records.shift()!.map((header, index) => { const clean = index === 0 ? header.replace(/^\ufeff/, "") : header; name(clean); return clean; });
    if (new Set(headers).size !== headers.length) throw new DmpSampleError("CSV header names must be distinct.");
    rows = records.length;
    records.forEach((row, rowIndex) => { if (row.length !== headers.length) throw new DmpSampleError("Every CSV row must match the header count."); row.forEach((value, index) => visit(`/rows/*/${escapePath(headers[index])}`, value === "" ? "empty" : /^(?:true|false)$/i.test(value) ? "boolean_text" : /^-?\d+(?:\.\d+)?$/.test(value) ? "number_text" : "string", value, `/rows/${rowIndex}/${escapePath(headers[index])}`)); });
    if (!rows) for (const header of headers) visit(`/rows/*/${escapePath(header)}`, "header_only");
  } else {
    if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(body)) throw new DmpSampleError("XML declarations with DOCTYPE or ENTITY are prohibited.");
    const parser = new SaxesParser({ xmlns: false });
    const stack: Array<{ path: string; node: XmlSourceNode; children: Map<string, number> }> = []; let documentOrder = 0;
    parser.on("error", () => { throw new DmpSampleError("Use a complete, well-formed body-only XML export."); });
    parser.on("doctype", () => { throw new DmpSampleError("XML document types are prohibited."); });
    parser.on("processinginstruction", () => { throw new DmpSampleError("XML processing instructions are prohibited."); });
    parser.on("xmldecl", declaration => { if (declaration.encoding && !/^(?:utf-8|us-ascii)$/i.test(declaration.encoding)) throw new DmpSampleError("Use a UTF-8 XML body export."); });
    parser.on("opentag", tag => {
      name(tag.name); if (stack.length >= SAMPLE_LIMITS.depth) throw new DmpSampleError("XML exceeds 24 nesting levels.", 413);
      const parent = stack.at(-1), ordinal = parent?.children.get(tag.name) ?? 0;
      parent?.children.set(tag.name, ordinal + 1);
      const node: XmlSourceNode = { elementName: tag.name, sourcePath: `${parent?.node.sourcePath ?? ""}/${escapePath(tag.name)}[${ordinal}]`, parentSourcePath: parent?.node.sourcePath ?? null, documentOrder: documentOrder++, attributes: {}, text: "" };
      const current = { path: childPath(parent?.path ?? "", tag.name), node, children: new Map<string, number>() };
      stack.push(current); visit(current.path, "element", undefined, node.sourcePath);
      const attrs = Object.entries(tag.attributes); if (attrs.length > SAMPLE_LIMITS.attributesPerNode) throw new DmpSampleError("XML has too many attributes on one element.", 413);
      for (const [key, value] of attrs) { name(key); node.attributes[key] = String(value); visit(`${current.path}/@${escapePath(key)}`, "attribute", String(value), `${node.sourcePath}/@${escapePath(key)}`); }
    });
    const text = (value: string) => { const current = stack.at(-1); if (!current) { if (value.trim()) throw new DmpSampleError("XML text must be within its root element."); return; } current.node.text += value; if (current.node.text.length > SAMPLE_LIMITS.valueCharacters) throw new DmpSampleError("XML element text is too large.", 413); };
    parser.on("text", text); parser.on("cdata", text);
    parser.on("closetag", () => { const current = stack.pop()!; current.node.text = current.node.text.trim(); if (current.node.text) visit(`${current.path}/#text`, "text", current.node.text, `${current.node.sourcePath}/#text`); onXmlNode?.(current.node); });
    try { parser.write(body).close(); } catch (error) { if (error instanceof DmpSampleError) throw error; throw new DmpSampleError("Use a complete, well-formed body-only XML export."); }
    if (!nodes) throw new DmpSampleError("XML needs a root element.");
  }
  const structure: SampleStructure = { format, nodes, rows, fields: [...fields].map(([path, field]) => ({ path, types: [...field.types].sort(), occurrences: field.count, distinctValues: field.distinct.size })), limitations: "Structure and explicitly requested bounded values only. Names, quantities, statuses and dates are evidence for manual review; no identifier mapping, all-day coverage, appliance identity, official-finals meaning or physical completion is inferred." };
  if (query && !fields.has(query.fieldPath)) throw new DmpSampleError("Choose an exact field path from this sample's structure.", 404);
  return { structure, ...(query ? { values: { fieldPath: query.fieldPath, items: selected.map(({ sourcePath, type, value, occurrence, truncated }) => ({ sourcePath, type, value, occurrence, truncated })), offset, totalOccurrences: selectedCount, nextOffset: offset + selected.length < selectedCount ? offset + selected.length : null, valueCharacters: SAMPLE_LIMITS.returnedValueCharacters } } : {}) };
}
