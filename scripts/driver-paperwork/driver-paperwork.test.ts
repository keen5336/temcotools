import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { GET } from "../../app/api/driver-paperwork/payload/route";
import { buildDriverPaperworkBookmarklet } from "../../lib/driver-paperwork/bookmarklet";

const source = readFileSync(new URL("./payload.js", import.meta.url), "utf8");
const bookmarklet = buildDriverPaperworkBookmarklet("https://temco.example");
const manifest = `HOME DEPOT ROUTE MANIFEST
Route: SH31
Driver Name: DOE, JANE
DATE: 11/07/2026
Total Distance (mi): 123.6
0
Location #\t3PL MDO 5288
1
Location #\tHD DELIVERY
Customer Order #\tORDER-1
DWO #\tDWO-1
MSN #\tMSN-1
ETA\t8:00 AM - 10:00 AM
Service Type\tSTH
\tAVERY & NORTH\t1 Main Street, Minneapolis MN 55401\t120.5\t1
Qty\tSKU\tDescription
1\t00010\tWasher & dryer kit`;

type Script = {
  src: string;
  crossOrigin: string;
  referrerPolicy: string;
  removed: boolean;
  onload?: () => void;
  onerror?: () => void;
  remove: () => void;
};

function harness({ text = manifest, answer = "SH31", blocked = false } = {}) {
  const alerts: string[] = [];
  const prompts: string[] = [];
  const events: string[] = [];
  const scripts: Script[] = [];
  const popups: ReturnType<typeof popup>[] = [];
  const timers = new Map<number, () => void>();
  let clock = 0;
  function popup() {
    let html = "";
    const window = {
      closed: false,
      opener: {} as unknown,
      focused: false,
      close() { window.closed = true; },
      focus() { window.focused = true; },
      document: {
        title: "",
        body: { textContent: "" },
        open() { html = ""; },
        write(value: string) { html += value; },
        close() {},
        querySelectorAll() { return []; },
        getElementById() { return { addEventListener() {} }; },
      },
      get html() { return html; },
    };
    return window;
  }
  const document = {
    body: { innerText: text },
    currentScript: null as Script | null,
    head: { appendChild(script: Script) { events.push("download"); scripts.push(script); } },
    createElement(tag: string) {
      assert.equal(tag, "script");
      const script: Script = { src: "", crossOrigin: "", referrerPolicy: "", removed: false, remove() { script.removed = true; } };
      return script;
    },
  };
  const window: Record<string, unknown> = {
    open() {
      events.push("open");
      if (blocked) return null;
      const opened = popup();
      popups.push(opened);
      return opened;
    },
  };
  const context = createContext({
    window, document,
    Date: class extends Date { static now() { return ++clock; } },
    alert(message: string) { alerts.push(message); },
    prompt(message: string) { prompts.push(message); return answer; },
    setTimeout(callback: () => void) { const id = ++clock; timers.set(id, callback); return id; },
    clearTimeout(id: number) { timers.delete(id); },
  });
  return {
    alerts, prompts, events, scripts, popups, timers, window,
    run() { runInContext(bookmarklet.slice("javascript:".length), context); },
    deliver(index = scripts.length - 1, code = source) {
      const script = scripts[index];
      document.currentScript = script;
      try { runInContext(code, context); }
      finally { document.currentScript = null; }
      script.onload?.();
    },
    timeout() { for (const callback of [...timers.values()]) callback(); },
  };
}

test("the bookmark opens its window before downloading a small, anonymous loader", () => {
  assert(Buffer.byteLength(bookmarklet) < 2048);
  const page = harness();
  page.run();
  assert.deepEqual(page.events, ["open", "download"]);
  const url = new URL(page.scripts[0].src);
  assert.equal(url.origin, "https://temco.example");
  assert.equal(url.pathname, "/api/driver-paperwork/payload");
  assert.deepEqual([...url.searchParams.keys()], ["t"]);
  assert.equal(page.scripts[0].crossOrigin, "anonymous");
  assert.equal(page.scripts[0].referrerPolicy, "no-referrer");
  assert.equal(page.popups[0].opener, null);
  assert.equal(page.prompts.length, 0);
});

test("the public payload response is executable JavaScript with fresh cross-origin loading", async () => {
  const response = GET();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /application\/javascript/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "cross-origin");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.has("set-cookie"), false);
  assert.equal(await response.text(), source);
});

test("a downloaded payload renders the existing booklet from local manifest text", () => {
  const page = harness();
  page.run();
  page.deliver();
  assert.deepEqual(page.alerts, []);
  assert.equal(page.popups.length, 1);
  const booklet = page.popups[0];
  assert.equal(booklet.closed, false);
  assert.equal(booklet.focused, true);
  assert.match(booklet.html, /<div class="route-name">SH31<\/div>/);
  assert.match(booklet.html, /DOE JANE/);
  assert.match(booklet.html, /class="miles-value">124</);
  assert.match(booklet.html, /<span>STH<\/span><strong>1<\/strong>/);
  assert.match(booklet.html, /<span>APP<\/span><strong>0<\/strong>/);
  assert.match(booklet.html, /AVERY &amp; NORTH/);
  assert.match(booklet.html, /00010/);
  assert.match(booklet.html, /Washer &amp; dryer kit/);
  assert.match(booklet.html, /data:image\/jpeg;base64,/);
  assert.match(booklet.html, /aria-label="Dock or wave"/);
  assert.match(booklet.html, /id="print-booklet"/);
  assert.equal(page.window.__temcoDriverPaperwork, undefined);
  assert.equal(page.timers.size, 0);
  assert.equal(page.scripts[0].removed, true);
});

test("a mixed route identifies all three page types while retaining stop order, fields, and cover totals", () => {
  const start = manifest.indexOf("1\nLocation #");
  const stop = manifest.slice(start);
  const services = ["STH - Outside Delivery", "Home Delivery", "MO - Revisit"];
  const text = manifest.slice(0, start) + services.map((service, index) => stop
    .replace(/^1\n/, `${index + 1}\n`)
    .replace("ORDER-1", `ORDER-${index + 1}`)
    .replace("Service Type\tSTH", `Service Type\t${service}`)).join("\n");
  const page = harness({ text });
  page.run();
  page.deliver();
  assert.deepEqual(page.alerts, []);
  const html = page.popups[0].html;
  assert.deepEqual([...html.matchAll(/data-page-type="([^"]+)"/g)].map(match => match[1]), ["sth", "home-delivery", "revisit"]);
  assert.deepEqual([...html.matchAll(/class="service-page-type">([^<]+)</g)].map(match => match[1]), ["STH - Outside Delivery", "Home Delivery", "Revisit"]);
  assert.deepEqual([...html.matchAll(/<b>STOP (\d+)<\/b>/g)].map(match => match[1]), ["1", "2", "3"]);
  for (const service of services) assert(html.includes(`<th scope="row">Service Type</th><td>${service}</td>`));
  assert.equal([...html.matchAll(/Washer &amp; dryer kit/g)].length, 3);
  assert.equal([...html.matchAll(/class="survey-panel"/g)].length, 3);
  assert.equal([...html.matchAll(/alt="The Home Depot"/g)].length, 3);
  assert.match(html, /background:#ffeb73/);
  assert.match(html, /print-color-adjust:exact/);
  assert.match(html, /Your Delivery Team:/);
  const cover = html.slice(html.indexOf('<section class="page cover">'), html.indexOf('<section class="page manifest-page">'));
  assert(!cover.includes('survey-panel'));
  assert.match(html, /<span>STH<\/span><strong>1<\/strong>/);
  assert.match(html, /<span>APP<\/span><strong>2<\/strong>/);
});

for (const [service, expected] of [
  ["MO", "revisit"],
  ["  mo - inspection", "revisit"],
  ["MO - STH follow-up", "revisit"],
  ["sth - Outside Delivery", "sth"],
  ["APP - Home Delivery", "home-delivery"],
] as const) {
  test(`Service Type ${service.trim()} selects the ${expected} page`, () => {
    const page = harness({ text: manifest.replace("Service Type\tSTH", `Service Type\t${service}`) });
    page.run();
    page.deliver();
    assert.deepEqual(page.alerts, []);
    assert(page.popups[0].html.includes(`data-page-type="${expected}"`));
  });
}

test("network failure closes the loading window and permits a fresh download", () => {
  const page = harness();
  page.run();
  page.scripts[0].onerror!();
  assert.match(page.alerts[0], /Could not load/);
  assert.equal(page.popups[0].closed, true);
  assert.equal(page.window.__temcoDriverPaperwork, undefined);
  assert.equal(page.timers.size, 0);
  page.run();
  assert.notEqual(page.scripts[0].src, page.scripts[1].src);
  page.deliver();
  assert.equal(page.popups[1].closed, false);
  assert.match(page.popups[1].html, /SH31 Driver Paperwork/);
});

test("a late timed-out script cannot take over a newer bookmark invocation", () => {
  const page = harness();
  page.run();
  page.timeout();
  assert.match(page.alerts[0], /too long/);
  assert.equal(page.popups[0].closed, true);
  page.run();
  page.deliver(0);
  assert.equal(page.prompts.length, 0);
  assert.equal(page.popups[1].html, "");
  page.deliver(1);
  assert.equal(page.prompts.length, 1);
  assert.match(page.popups[1].html, /SH31 Driver Paperwork/);
});

test("duplicate clicks while loading request and open only once", () => {
  const page = harness();
  page.run();
  page.run();
  assert.equal(page.scripts.length, 1);
  assert.equal(page.popups.length, 1);
  page.deliver();
  page.run();
  assert.equal(page.scripts.length, 2);
  assert.equal(page.popups.length, 2);
});

test("blocked popups do not download a program or prompt for a route", () => {
  const page = harness({ blocked: true });
  page.run();
  assert.match(page.alerts[0], /Allow pop-ups/);
  assert.equal(page.scripts.length, 0);
  assert.equal(page.prompts.length, 0);
});

test("an empty or invalid payload reports a startup failure and closes the window", () => {
  const page = harness();
  page.run();
  page.deliver(0, "");
  assert.match(page.alerts[0], /could not start/);
  assert.equal(page.popups[0].closed, true);
  assert.equal(page.window.__temcoDriverPaperwork, undefined);
});

for (const [name, options, expected] of [
  ["cancelled route", { answer: "" }, null],
  ["invalid route", { answer: "SH31<script>" }, /Enter a route/],
  ["missing route", { answer: "SH99" }, /not found/],
  ["unreadable manifest", { text: manifest.replace("1 Main Street, Minneapolis MN 55401", "unreadable") }, /Could not read/],
] as const) {
  test(`${name} closes the loading window without leaving a pending invocation`, () => {
    const page = harness(options);
    page.run();
    page.deliver();
    assert.equal(page.popups[0].closed, true);
    assert.equal(page.window.__temcoDriverPaperwork, undefined);
    if (expected) assert.match(page.alerts[0], expected);
    else assert.deepEqual(page.alerts, []);
  });
}
