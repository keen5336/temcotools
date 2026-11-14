import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createContext, runInContext, Script } from "node:vm";
import { buildDriverPaperworkBookmarklet } from "../../lib/driver-paperwork/bookmarklet";
import { buildDriverPaperworkPayload } from "../../lib/driver-paperwork/payload";
import { getDefaultProgram, validateProgram } from "../../lib/driver-paperwork/program";
import { DEFAULT_TEMPLATES, templateSchema } from "../../lib/driver-paperwork/templates";
import { buildTemplatePreview } from "../../lib/driver-paperwork/preview";
import { SAMPLE_MANIFEST } from "../../lib/driver-paperwork/sample";
import { createDriverPaperworkRuntime } from "./runtime.mjs";
import { PAPERWORK_ASSETS } from "./assets.mjs";

const defaults = () => templateSchema.parse(DEFAULT_TEMPLATES);
const runtime = () => createDriverPaperworkRuntime(defaults(), PAPERWORK_ASSETS);
const other = SAMPLE_MANIFEST.replaceAll("SH31", "SH3").replaceAll("SAMPLE, DRIVER", "OTHER, DRIVER");
const stopPages = (html: string) => [...html.matchAll(/<section class="page stop-page"[\s\S]*?<\/footer><\/section>/g)].map(match => match[0]);

test("discovers exact route IDs and driver names in source order, combining repeated pages", () => {
  assert.deepEqual(runtime().discoverRoutes(SAMPLE_MANIFEST + other + SAMPLE_MANIFEST), [{ route: "SH31", driver: "SAMPLE DRIVER" }, { route: "SH3", driver: "OTHER DRIVER" }]);
  assert.deepEqual(runtime().discoverRoutes("not a manifest"), []);
});
test("batch booklet keeps independent covers, drivers, summaries, stops and surveys", () => {
  const html = runtime().buildBooklet(SAMPLE_MANIFEST + other, ["SH31", "SH3"]);
  assert.equal((html.match(/class="page cover"/g) || []).length, 2);
  assert.equal((html.match(/class="page manifest-page"/g) || []).length, 2);
  assert.equal(stopPages(html).length, 6);
  assert.equal((html.match(/class="survey-panel"/g) || []).length, 6);
  assert.match(html, /2 routes · 6 delivery stops/);
  assert.match(html, /data-route="SH31"[\s\S]*SAMPLE DRIVER[\s\S]*data-route="SH3"[\s\S]*OTHER DRIVER/);
  assert.equal((html.match(/id="print-booklet"/g) || []).length, 1);
});
test("one route never includes a prefix neighbour and duplicate selection does not duplicate output", () => {
  const html = runtime().buildBooklet(SAMPLE_MANIFEST + other, ["SH3", "SH3"]);
  assert.doesNotMatch(html, /SAMPLE DRIVER|data-route="SH31"/);
  assert.match(html, /OTHER DRIVER/);
  assert.equal(stopPages(html).length, 3);
});
test("repeated manifest sections deduplicate identical stops", () => {
  assert.equal(runtime().parseRoute(SAMPLE_MANIFEST + SAMPLE_MANIFEST, "SH31").stops.length, 3);
});
test("a batch fails on any missing, incomplete or conflicting route instead of returning partial paperwork", () => {
  assert.throws(() => runtime().buildBooklet(SAMPLE_MANIFEST, ["SH31", "SH99"]), /not found/);
  assert.throws(() => runtime().buildBooklet(SAMPLE_MANIFEST + other.replace("SAMPLE-1", ""), ["SH31", "SH3"]), /Could not read/);
  assert.throws(() => runtime().buildBooklet(SAMPLE_MANIFEST + SAMPLE_MANIFEST.replace("SAMPLE-1", "OTHER"), ["SH31"]), /different details/);
  assert.throws(() => runtime().buildBooklet(SAMPLE_MANIFEST + SAMPLE_MANIFEST.replace("11/14/2026", "11/15/2026"), ["SH31"]), /different drivers or dates/);
  assert.throws(() => runtime().buildBooklet(SAMPLE_MANIFEST, []), /at least one/);
});
test("default stop fields, item columns and headers preserve all three requested layouts", () => {
  const pages = stopPages(runtime().buildBooklet(SAMPLE_MANIFEST, ["SH31"]));
  assert.equal(pages.length, 3);
  const labels = (html: string) => [...html.matchAll(/<th scope="row">([^<]+)</g)].map(match => match[1]);
  assert.deepEqual(labels(pages[0]), ["Order", "DWO", "Service Type"]);
  assert.deepEqual(labels(pages[1]), ["Order", "MSN", "Service Type"]);
  assert.deepEqual(labels(pages[2]), ["Order", "Service Type"]);
  assert.doesNotMatch(pages[0].split("</header>")[0], /SH31|11\/14/);
  assert.match(pages[1].split("</header>")[0], /SH31/);
  assert.doesNotMatch(pages[2], /<th scope="col">(?:Qty|SKU)</);
  assert.match(pages[0], /<th scope="col">Qty/);
  assert.match(pages[1], /<th scope="col">SKU/);
  assert.match(pages[2], /Revisit/);
});
test("cover and route summary do not get surveys; legacy cover counts stay intact", () => {
  const html = runtime().buildBooklet(SAMPLE_MANIFEST, ["SH31"]);
  const beforeStops = html.slice(0, html.indexOf('<section class="page stop-page"'));
  assert.doesNotMatch(beforeStops, /<footer class="survey-panel"/);
  assert.match(beforeStops, /<span>STH<\/span><strong>1/);
  assert.match(beforeStops, /<span>APP<\/span><strong>2/);
  assert.match(html, /background:#ffeb73/);
  assert.match(html, /print-color-adjust:exact/);
});
test("edited rich text, fields, contacts, notes and visibility render with escaped manifest data", () => {
  const config = defaults();
  config.coverReminders = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello ", marks: [{ type: "bold" }] }, { type: "templateField", attrs: { name: "driver" } }] }] };
  config.pages.revisit.notes = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Order {{order}} · {{customer}}" }] }] };
  config.pages.revisit.sku = true; config.pages.revisit.fields = ["msn"];
  config.contacts[0][0] = { name: "Ashe <Ops>", phone: "555-0100" };
  const html = createDriverPaperworkRuntime(config, PAPERWORK_ASSETS).buildBooklet(SAMPLE_MANIFEST.replace("SAMPLE, DRIVER", "<script>, &"), ["SH31"]);
  assert.match(html, /<strong>Hello <\/strong>&lt;script&gt; &amp;/);
  assert.match(html, /Ashe &lt;Ops&gt;/);
  const revisit = stopPages(html)[2];
  assert.match(revisit, /Order SAMPLE-3 · SAMPLE CUSTOMER 3/);
  assert.match(revisit, /<th scope="col">SKU/);
  assert.doesNotMatch(revisit, /<th scope="row">Order/);
});
test("template schema rejects executable markup, unknown nodes/marks/attributes and template fields", () => {
  for (const node of [
    { type: "image", attrs: { src: "https://example.test" } },
    { type: "paragraph", attrs: { onclick: "alert(1)" } },
    { type: "paragraph", content: [{ type: "text", text: "link", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] },
    { type: "paragraph", content: [{ type: "templateField", attrs: { name: "cookie" } }] },
    { type: "paragraph", content: [{ type: "text", text: "{{password}}" }] },
  ]) {
    const config = defaults(); config.coverAttention = { type: "doc", content: [node] } as never;
    assert.equal(templateSchema.safeParse(config).success, false);
  }
  const config = defaults(); config.coverAttention = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: '<img src=x onerror="alert(1)">' }] }] };
  const html = createDriverPaperworkRuntime(templateSchema.parse(config), PAPERWORK_ASSETS).buildBooklet(SAMPLE_MANIFEST, ["SH31"]);
  assert.match(html, /&lt;img src=x/); assert.doesNotMatch(html, /<img src=x/);
});
test("JavaScript validation compiles without executing, rejects invalid and oversized source", () => {
  assert(validateProgram(getDefaultProgram()));
  assert(validateProgram("function createDriverPaperworkRuntime() { throw new Error('not executed on save'); }"));
  assert(!validateProgram("function createDriverPaperworkRuntime( {"));
  assert(!validateProgram("alert('no factory')"));
  assert(!validateProgram(getDefaultProgram() + " ".repeat(180_001)));
});
test("hosted payload contains saved templates and JavaScript and remains a classic script", () => {
  const config = defaults(); config.contacts[0][0].name = "EDITED";
  const source = buildDriverPaperworkPayload(config, getDefaultProgram() + "\n// EDITED PROGRAM");
  new Script(source);
  assert.match(source, /EDITED PROGRAM/); assert.match(source, /"name":"EDITED"/);
  assert.doesNotMatch(source, /export function/);
  const context = createContext({ document: { currentScript: null }, window: {} });
  runInContext(source, context); // stale/non-bookmark invocation is inert
});
test("preview has an opaque-origin, network-blocked document with only synthetic manifest data", () => {
  const html = buildTemplatePreview(defaults(), getDefaultProgram(), randomUUID());
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /SAMPLE CUSTOMER/);
  assert.doesNotMatch(html, /<script src="https?:/);
});

function loaderHarness() {
  const alerts: string[] = [];
  const timers = new Map<number, () => void>();
  const scripts: { src: string; crossOrigin?: string; referrerPolicy?: string; temcoDriverPaperwork?: { finished?: boolean }; onload?: () => void; onerror?: () => void; removed: boolean; remove: () => void }[] = [];
  const window: Record<string, unknown> = {};
  const context = createContext({ window, document: {
    createElement() { const script = { src: "", removed: false, remove() { script.removed = true; } }; return script; },
    head: { appendChild(script: typeof scripts[number]) { scripts.push(script); } },
  }, setTimeout(fn: () => void) { timers.set(timers.size + 1, fn); return timers.size; }, clearTimeout(id: number) { timers.delete(id); }, alert(message: string) { alerts.push(message); }, Date });
  return { alerts, timers, scripts, window, run() { runInContext(buildDriverPaperworkBookmarklet("https://temco.example").slice(11), context); } };
}
test("small anonymous loader mounts without opening windows or prompting, and cleans up", () => {
  const source = buildDriverPaperworkBookmarklet("https://temco.example"); assert(Buffer.byteLength(source) < 2048);
  const h = loaderHarness(); h.run(); h.run(); assert.equal(h.scripts.length, 1);
  const script = h.scripts[0]; const url = new URL(script.src);
  assert.equal(url.pathname, "/api/driver-paperwork/payload"); assert.deepEqual([...url.searchParams.keys()], ["t"]);
  assert.equal(script.crossOrigin, "anonymous"); assert.equal(script.referrerPolicy, "no-referrer");
  script.temcoDriverPaperwork!.finished = true; script.onload!();
  assert(script.removed); assert.equal(h.window.__temcoDriverPaperwork, undefined); assert.equal(h.timers.size, 0); assert.deepEqual(h.alerts, []);
});
test("load errors, startup errors and timeouts release retry guard; late scripts cannot clear a newer job", () => {
  for (const fail of ["network", "startup", "timeout"]) {
    const h = loaderHarness(); h.run(); const old = h.scripts[0];
    if (fail === "network") old.onerror!(); else if (fail === "startup") old.onload!(); else [...h.timers.values()][0]();
    assert.equal(h.alerts.length, 1); assert.equal(h.window.__temcoDriverPaperwork, undefined);
    h.run(); const next = h.window.__temcoDriverPaperwork; old.onload!(); assert.equal(h.window.__temcoDriverPaperwork, next);
  }
});
