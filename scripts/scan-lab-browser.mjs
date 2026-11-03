/** Isolated real Chromium software-camera/runtime qualification. Never connects to the app/database. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = process.env.SCAN_LAB_SANDBOX;
if (!sandbox)
  throw new Error(
    "SCAN_LAB_SANDBOX required (runtime dependencies plus React, esbuild, Playwright, bwip-js)",
  );
const req = createRequire(join(sandbox, "package.json"));
const { chromium } = req("@playwright/test"),
  { build } = req("esbuild"),
  bwip = req("bwip-js"),
  { PNG } = req("pngjs");
const output = join(
  sandbox,
  "evidence",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
await mkdir(output, { recursive: true });
await build({
  stdin: {
    contents: `import React from 'react';import{createRoot}from'react-dom/client';import Lab from ${JSON.stringify(join(root, "components/scan-lab/ScanLabClient.tsx"))};import{preprocess}from ${JSON.stringify(join(root, "lib/scan-lab/capture.ts"))};window.scanLabTest={preprocess};const appRoot=createRoot(document.getElementById('root'));window.scanLabTest.unmount=()=>appRoot.unmount();appRoot.render(<Lab/>);`,
    resolveDir: root,
    loader: "tsx",
  },
  outfile: join(output, "app.js"),
  bundle: true,
  format: "esm",
  jsx: "automatic",
  nodePaths: [join(sandbox, "node_modules")],
  loader: { ".css": "css" },
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
const types = {
  ".mjs": "text/javascript",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".json": "application/json",
  ".gz": "application/gzip",
  ".tar": "application/octet-stream",
};
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, "http://localhost").pathname;
    if (path === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end(
        '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body style="margin:0;background:#06121c"><div id="root"></div><script type="module" src="/app.js"></script></body></html>',
      );
      return;
    }
    const base = path.startsWith("/scan-lab/") ? join(root, "public") : output;
    const file = resolve(base, "." + path);
    if (!file.startsWith(base + "/")) throw new Error("invalid path");
    response.setHeader(
      "Content-Type",
      types[extname(file)] ?? "application/octet-stream",
    );
    response.end(await readFile(file));
  } catch {
    response.statusCode = 404;
    response.end("Missing fixture or asset");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
// A deterministic image is delivered through Chromium getUserMedia as a real MediaStream.
const cameraPng = PNG.sync.read(
  await bwip.toBuffer({
    bcid: "code128",
    text: "001234567890",
    scale: 3,
    height: 18,
    backgroundcolor: "FFFFFF",
    padding: 20,
  }),
);
const yuv = Buffer.alloc((640 * 360 * 3) / 2, 128);
yuv.fill(235, 0, 640 * 360);
const ratio = Math.min(600 / cameraPng.width, 320 / cameraPng.height),
  cw = Math.floor(cameraPng.width * ratio),
  ch = Math.floor(cameraPng.height * ratio),
  cx = Math.floor((640 - cw) / 2),
  cy = Math.floor((360 - ch) / 2);
for (let y = 0; y < ch; y++)
  for (let x = 0; x < cw; x++) {
    const i =
      (Math.floor(y / ratio) * cameraPng.width + Math.floor(x / ratio)) * 4;
    const value =
      (cameraPng.data[i] + cameraPng.data[i + 1] + cameraPng.data[i + 2]) / 3;
    yuv[(y + cy) * 640 + x + cx] = Math.round(16 + (219 * value) / 255);
  }
const cameraText = PNG.sync.read(
  await readFile(join(root, "public/scan-lab/fixtures/serial-clean.png")),
);
for (let y = 0; y < 105; y++)
  for (let x = 0; x < 490; x++) {
    const i =
      (Math.floor((y * cameraText.height) / 105) * cameraText.width +
        Math.floor((x * cameraText.width) / 490)) *
      4;
    const value =
      (cameraText.data[i] + cameraText.data[i + 1] + cameraText.data[i + 2]) /
      3;
    yuv[(y + 5) * 640 + x + 20] = Math.round(16 + (219 * value) / 255);
  }
const cameraFixture = join(output, "software-camera.y4m");
await writeFile(
  cameraFixture,
  Buffer.concat([
    Buffer.from("YUV4MPEG2 W640 H360 F5:1 Ip A1:1 C420jpeg\n"),
    ...Array.from({ length: 10 }, () =>
      Buffer.concat([Buffer.from("FRAME\n"), yuv]),
    ),
  ]),
);
const browser = await chromium.launch({
  headless: true,
  channel: process.env.SCAN_LAB_BROWSER_CHANNEL || "chrome",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--disable-gpu",
    `--use-file-for-fake-video-capture=${cameraFixture}`,
  ],
});
const results = {
  environment: {
    browser: browser.version(),
    physicalHardware: false,
    origin: "loopback isolated fixture harness",
    gpu: "disabled",
    headers: "no COOP/COEP",
    date: new Date().toISOString(),
  },
  checks: [],
  measurements: [],
  errors: [],
};
let context;
try {
  context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    permissions: ["camera"],
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on("pageerror", (e) => {
    results.errors.push(e.message);
    console.log("Page error:", e.message);
  });
  page.on("console", (m) => {
    if (m.text().startsWith("ENGINE")) console.log(m.text());
    if (m.type() === "error" && !m.text().includes("CleanUnusedInitializers"))
      console.log("Browser:", m.text());
  });
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.abort(),
  );
  console.log("Harness ready", origin);
  await page.goto(origin);
  await page
    .getByRole("heading", { name: "TemcoScan Lab", exact: true })
    .waitFor();
  console.log("Client mounted");
  // Ground truth is entirely synthetic. No photographed/customer labels.
  const fixtureDir = join(root, "public/scan-lab/fixtures");
  await mkdir(fixtureDir, { recursive: true });
  const fixtures = [
    {
      id: "serial-clean",
      text: "SERIAL: 001O-I1S5-8B\nMODEL: QX-007",
      width: 1100,
      height: 240,
      font: 50,
    },
    {
      id: "dense-lpn",
      text: "LPN: 0000123401\nLOCATION: A-01-005\nSERIAL: 0O-1I-5S-8B",
      width: 1000,
      height: 240,
      font: 28,
    },
    {
      id: "shadow",
      text: "SERIAL: 001O-I1S5-8B\nMODEL: QX-007",
      width: 1100,
      height: 240,
      font: 50,
      shadow: true,
    },
    {
      id: "glare",
      text: "SERIAL: 001O-I1S5-8B\nMODEL: QX-007",
      width: 1100,
      height: 240,
      font: 50,
      glare: true,
    },
    {
      id: "angle",
      text: "SERIAL: 001O-I1S5-8B\nMODEL: QX-007",
      width: 1100,
      height: 340,
      font: 50,
      angle: true,
    },
    {
      id: "small-low-light",
      text: "LPN: 0000123401\nMODEL: QX-007",
      width: 700,
      height: 180,
      font: 20,
      low: true,
    },
    {
      id: "damage",
      text: "SERIAL: 001O-I1S5-8B\nMODEL: QX-007",
      width: 1100,
      height: 240,
      font: 50,
      damage: true,
    },
    {
      id: "motion",
      text: "SERIAL: 001O-I1S5-8B\nMODEL: QX-007",
      width: 1100,
      height: 240,
      font: 50,
      motion: true,
    },
    {
      id: "curved",
      text: "SERIAL: 001O-I1S5-8B\nMODEL: QX-007",
      width: 1100,
      height: 280,
      font: 50,
      curved: true,
    },
  ];
  if (process.argv.includes("--fixtures")) {
    for (const f of fixtures) {
      const data = await page.evaluate((f) => {
        const c = document.createElement("canvas");
        c.width = f.width;
        c.height = f.height;
        const x = c.getContext("2d");
        x.fillStyle = f.low ? "#4c4c4c" : "white";
        x.fillRect(0, 0, c.width, c.height);
        x.font = `${f.font}px monospace`;
        x.fillStyle = f.low ? "#212121" : "black";
        if (f.angle) {
          x.translate(45, 10);
          x.rotate(0.09);
        }
        if (f.motion) x.filter = "blur(2px)";
        f.text.split("\n").forEach((line, i) => {
          if (!f.curved) x.fillText(line, 35, 75 + i * (f.font + 30));
          else {
            let at = 35;
            for (let j = 0; j < line.length; j++) {
              x.save();
              x.translate(at, 90 + i * (f.font + 30) + 20 * Math.sin(j / 4));
              x.rotate(0.09 * Math.cos(j / 4));
              x.fillText(line[j], 0, 0);
              x.restore();
              at += f.font * 0.61;
            }
          }
        });
        x.filter = "none";
        if (f.shadow) {
          const g = x.createLinearGradient(0, 0, c.width, 0);
          g.addColorStop(0, "#000b");
          g.addColorStop(0.8, "#0000");
          x.fillStyle = g;
          x.fillRect(0, 0, c.width, c.height);
        }
        if (f.glare) {
          const g = x.createLinearGradient(200, 0, 800, 0);
          g.addColorStop(0, "#fff0");
          g.addColorStop(0.5, "#ffff");
          g.addColorStop(1, "#fff0");
          x.fillStyle = g;
          x.fillRect(0, 0, c.width, c.height);
        }
        if (f.damage) {
          x.fillStyle = "white";
          x.fillRect(250, 32, 12, 65);
          x.fillRect(480, 66, 50, 4);
        }
        return c.toDataURL().split(",")[1];
      }, f);
      await writeFile(
        join(fixtureDir, `${f.id}.png`),
        Buffer.from(data, "base64"),
      );
    }
    for (const [name, bcid, text] of [
      ["code128", "code128", "001234567890"],
      ["qr", "qrcode", "TEMCO-LAB-00001"],
    ])
      await writeFile(
        join(fixtureDir, `${name}.png`),
        await bwip.toBuffer({
          bcid,
          text,
          scale: 3,
          height: 18,
          includetext: true,
          backgroundcolor: "FFFFFF",
          padding: 15,
        }),
      );
    const combined = await page.evaluate(async () => {
      const images = await Promise.all(
        ["code128", "qr"].map(async (name) =>
          createImageBitmap(
            await fetch(`/scan-lab/fixtures/${name}.png`).then((r) => r.blob()),
          ),
        ),
      );
      const c = document.createElement("canvas");
      c.width = 1200;
      c.height = 500;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, 1200, 500);
      ctx.drawImage(images[0], 35, 130, 520, 190);
      ctx.drawImage(images[1], 760, 70, 320, 320);
      images.forEach((i) => i.close());
      return c.toDataURL().split(",")[1];
    });
    await writeFile(
      join(fixtureDir, "code128-and-qr.png"),
      Buffer.from(combined, "base64"),
    );
    await writeFile(
      join(fixtureDir, "ground-truth.json"),
      JSON.stringify(
        {
          origin:
            "Generated locally by scripts/scan-lab-browser.mjs --fixtures; synthetic, no customer data",
          license: "CC0-1.0",
          fixtures: fixtures.map((f) => ({
            file: `${f.id}.png`,
            expected: f.text,
            condition: f.id,
          })),
          barcodes: [
            {
              file: "code128.png",
              expected: "001234567890",
              format: "CODE_128",
            },
            { file: "qr.png", expected: "TEMCO-LAB-00001", format: "QR_CODE" },
            {
              file: "code128-and-qr.png",
              expected: ["001234567890", "TEMCO-LAB-00001"],
              note: "ZXing returns one barcode per crop; crop the left/right half to compare both",
            },
          ],
        },
        null,
        2,
      ),
    );
  }
  console.log("Fixtures ready");
  await page
    .getByRole("button", { name: "Load synthetic text fixture", exact: true })
    .click();
  await page.getByAltText("Local replay frame").waitFor();
  const lazy = await page.evaluate(
    () =>
      performance
        .getEntriesByType("resource")
        .filter((r) => r.name.includes("/vendor/")).length,
  );
  assert.equal(lazy, 0);
  results.checks.push("No recognition runtime/model download before capture");
  await page.evaluate(() => {
    let previous = "";
    new MutationObserver(() => {
      const s = [...document.querySelectorAll('[aria-live="polite"]')]
        .map((e) => e.textContent)
        .join(" ");
      if (s !== previous) {
        previous = s;
        console.log("ENGINE", s);
      }
    }).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  console.log("Starting real same-frame comparison");
  await page
    .getByRole("button", {
      name: "Compare Tesseract + Paddle · same frame",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Scan / Capture", exact: true })
    .waitFor({ timeout: 180000 });
  console.log("Comparison complete");
  const detail = await page
    .locator('section[aria-label="Recognition controls"]')
    .locator('[role="alert"]')
    .allTextContents();
  if (detail.length) results.errors.push(...detail);
  const attempts = await page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: /Session history/ }) })
    .locator("details pre")
    .allTextContents();
  const first = JSON.parse(attempts[0]);
  results.measurements.push({ fixture: "serial-clean", ...first });
  await writeFile(
    join(output, "first-inference.json"),
    JSON.stringify(first, null, 2),
  );
  assert.equal(first.outputs.length, 2, first.error ?? "Both engines must run");
  assert.equal(first.status, "success");
  assert.ok(first.outputs.every((o) => o.rawText.includes("QX-007")));
  assert.ok(first.frameId);
  assert.equal(
    first.outputs.find((o) => o.engine === "paddle").runtime.detProvider,
    "wasm",
  );
  results.checks.push(
    "Actual Tesseract and Paddle mobile WASM inference on identical PNG blob/frame hash",
  );
  await page.getByLabel("Input source", { exact: true }).selectOption("upload");
  await page
    .getByLabel("Barcode backend", { exact: true })
    .selectOption("zxing");
  await page.getByLabel("Task", { exact: true }).selectOption("barcode");
  for (const f of ["code128", "qr"]) {
    const oldUrl = await page
      .getByAltText("Local replay frame")
      .getAttribute("src");
    await page
      .locator('input[type="file"]')
      .setInputFiles(join(fixtureDir, `${f}.png`));
    await page.waitForFunction(
      (old) =>
        document
          .querySelector('img[alt="Local replay frame"]')
          ?.getAttribute("src") !== old,
      oldUrl,
    );
    await page
      .getByRole("button", { name: "Scan / Capture", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Scan / Capture", exact: true })
      .waitFor({ timeout: 60000 });
    const raw = await page
      .getByLabel("zxing raw text", { exact: true })
      .innerText();
    assert.equal(raw, f === "code128" ? "001234567890" : "TEMCO-LAB-00001");
  }
  results.checks.push("Real ZXing Code128 and QR exact-match decoding");
  const multi = await page.evaluate(async () => {
    const { decode } = await import("/scan-lab/vendor/zxing.mjs");
    const bitmap = await createImageBitmap(
      await fetch("/scan-lab/fixtures/code128-and-qr.png").then((r) =>
        r.blob(),
      ),
    );
    const c = document.createElement("canvas");
    c.width = bitmap.width;
    c.height = bitmap.height;
    c.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close();
    return [0, 0.5].map(
      (x) =>
        decode(
          window.scanLabTest.preprocess(
            c,
            { x, y: 0, width: 0.5, height: 1 },
            {
              rotation: 0,
              grayscale: false,
              threshold: false,
              contrast: 1,
              maxEdge: 1600,
            },
          ),
        )[0]?.rawText,
    );
  });
  assert.deepEqual(multi, ["001234567890", "TEMCO-LAB-00001"]);
  results.checks.push(
    "Two real barcodes in one image are independently decoded through production ROI crops",
  );
  // Actual camera API with Chromium's synthetic device, not a physical unit.
  await page.getByRole("button", { name: "Start Camera", exact: true }).click();
  await page
    .getByRole("button", { name: "Stop Camera", exact: true })
    .waitFor();
  await page.waitForFunction(
    () => document.querySelector("video").videoWidth > 0,
  );
  assert.equal(await page.locator("video").getAttribute("playsinline"), "");
  const settings = await page.locator("video").evaluate((v) => ({
    settings: v.srcObject.getVideoTracks()[0].getSettings(),
    inline: v.playsInline,
    ready: v.readyState,
  }));
  results.camera = settings;
  await page.getByLabel("Crop to ROI", { exact: true }).check();
  await page.getByLabel("ROI x percent", { exact: true }).fill("10");
  const roi = page.getByTestId("roi");
  const box = await roi.boundingBox();
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.mouse.up();
  assert.notEqual(
    await page.getByLabel("ROI x percent", { exact: true }).inputValue(),
    "10",
  );
  results.checks.push(
    "Actual getUserMedia fake-camera settings/inline video and pointer ROI movement",
  );
  await page.getByLabel("Crop to ROI", { exact: true }).uncheck();
  await page
    .getByRole("button", { name: "Scan / Capture", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Scan / Capture", exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("zxing raw text", { exact: true }).innerText(),
    "001234567890",
  );
  results.checks.push(
    "Actual software-camera MediaStream -> production capture -> ZXing exact match",
  );
  await page.getByLabel("Task", { exact: true }).selectOption("ocr");
  await page
    .getByLabel("OCR backend", { exact: true })
    .selectOption("tesseract");
  await page
    .getByRole("button", { name: "Scan / Capture", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Scan / Capture", exact: true })
    .waitFor();
  const cameraOcr = await page
    .getByLabel("tesseract raw text", { exact: true })
    .innerText();
  assert.match(cameraOcr, /QX-007/);
  results.camera.ocrRawText = cameraOcr;
  results.checks.push(
    "Actual software-camera MediaStream -> local Tesseract WASM OCR returns printed model text",
  );
  await page.getByLabel("Task", { exact: true }).selectOption("barcode");
  const beforeContinuous = await page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: /Session history/ }) })
    .locator("details")
    .count();
  await page.getByLabel("Continuous camera capture", { exact: true }).check();
  await page.waitForFunction(
    (n) =>
      document.querySelectorAll('[data-testid="scan-history"] details')
        .length >=
      n + 2,
    beforeContinuous,
    { timeout: 15000 },
  );
  await page.getByLabel("Continuous camera capture", { exact: true }).uncheck();
  const continuousAttempts = await page
    .locator('[data-testid="scan-history"] details pre')
    .allTextContents();
  assert.ok(
    continuousAttempts
      .map((text) => JSON.parse(text))
      .some((a) => a.source === "camera" && a.isDuplicate),
  );
  results.checks.push(
    "Continuous software-camera attempts complete with bounded admission and duplicate marking",
  );
  await page.getByRole("button", { name: "Stop Camera", exact: true }).click();
  assert.equal(await page.locator("video").evaluate((v) => v.srcObject), null);
  const closing = page
    .workers()
    .map((w) => w.waitForEvent("close", { timeout: 5000 }));
  await page
    .getByRole("button", { name: "Cancel / reset engines", exact: true })
    .click();
  await Promise.all(closing);
  assert.equal(page.workers().length, 0);
  results.checks.push("Reset closes OCR hosts and their worker trees");
  const blankBarcode = await page.evaluate(async () => {
    const { decode } = await import("/scan-lab/vendor/zxing.mjs");
    const c = document.createElement("canvas");
    c.width = 640;
    c.height = 360;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, 640, 360);
    return decode(c);
  });
  assert.deepEqual(blankBarcode, []);
  results.checks.push(
    "Real ZXing blank-image miss returns no fabricated barcode",
  );
  // An actual absent model must fail visibly and leave the UI recoverable.
  await page
    .getByRole("button", { name: "Load synthetic text fixture", exact: true })
    .click();
  await page.getByLabel("Task", { exact: true }).selectOption("ocr");
  await page.getByLabel("OCR backend", { exact: true }).selectOption("paddle");
  await page.route(
    "**/scan-lab/vendor/paddle/PP-OCRv5_mobile_det.tar",
    (route) => route.fulfill({ status: 404, body: "Missing test model" }),
  );
  await page
    .getByRole("button", { name: "Scan / Capture", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Scan / Capture", exact: true })
    .waitFor({ timeout: 30000 });
  assert.match(await page.getByRole("alert").innerText(), /404/);
  await page.unroute("**/scan-lab/vendor/paddle/PP-OCRv5_mobile_det.tar");
  await page
    .getByRole("button", { name: "Cancel / reset engines", exact: true })
    .click();
  results.checks.push(
    "Missing real Paddle model fails visibly without stuck admission",
  );
  if (process.argv.includes("--matrix")) {
    console.log("Running synthetic OCR condition matrix");
    results.matrix = await page.evaluate(async (fixtures) => {
      const workers = new Map();
      const rows = [];
      let nextId = 0;
      const request = (worker, type, extra = {}) =>
        new Promise((resolve, reject) => {
          const id = ++nextId;
          const timeout = setTimeout(
            () => reject(new Error("Matrix worker timeout")),
            60000,
          );
          worker.onmessage = ({ data }) => {
            if (data.id !== id) return;
            clearTimeout(timeout);
            if (data.type === "error") reject(new Error(data.error));
            else resolve(data.output);
          };
          worker.onerror = (e) => {
            clearTimeout(timeout);
            reject(new Error(e.message));
          };
          worker.postMessage({ id, type, ...extra });
        });
      try {
        for (const engine of ["tesseract", "paddle"]) {
          const worker = new Worker("/scan-lab/ocr-host.mjs", {
            type: "module",
          });
          workers.set(engine, worker);
          await request(worker, "init", { engine });
        }
        for (const fixture of fixtures) {
          const blob = await fetch(`/scan-lab/fixtures/${fixture.id}.png`).then(
            (r) => r.blob(),
          );
          const hash = [
            ...new Uint8Array(
              await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
            ),
          ]
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
          for (const [engine, worker] of workers) {
            const result = await request(worker, "recognize", { blob });
            rows.push({
              fixture: fixture.id,
              expected: fixture.text,
              pngSha256: hash,
              engine,
              rawText: result.rawText,
              inferenceMs: result.inferenceMs,
              detections: result.detections,
              runtime: result.runtime,
            });
          }
        }
        return rows;
      } finally {
        workers.forEach((w) => w.terminate());
      }
    }, fixtures);
    assert.equal(results.matrix.length, fixtures.length * 2);
    for (const fixture of fixtures) {
      const pair = results.matrix.filter((r) => r.fixture === fixture.id);
      assert.equal(pair[0].pngSha256, pair[1].pngSha256);
    }
    results.checks.push(
      "Real two-engine OCR condition matrix uses identical saved inputs; raw misreads retained",
    );
  }
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  assert.equal(overflow, false);
  results.checks.push("390px mobile layout has no page horizontal overflow");
  await page.screenshot({
    path: join(output, "mobile-lab.png"),
    fullPage: true,
  });
  // Crop/rotation pixels exercise the production canvas code, not a geometry stand-in.
  const pixels = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 100;
    c.height = 60;
    const x = c.getContext("2d");
    x.fillStyle = "red";
    x.fillRect(0, 0, 50, 60);
    x.fillStyle = "blue";
    x.fillRect(50, 0, 50, 60);
    const p = window.scanLabTest.preprocess(
      c,
      { x: 0.5, y: 0, width: 0.5, height: 1 },
      {
        rotation: 90,
        grayscale: false,
        threshold: false,
        contrast: 1,
        maxEdge: 1600,
      },
    );
    return {
      width: p.width,
      height: p.height,
      pixel: [...p.getContext("2d").getImageData(30, 25, 1, 1).data],
    };
  });
  assert.deepEqual(pixels, { width: 60, height: 50, pixel: [0, 0, 255, 255] });
  results.checks.push(
    "Production canvas crops source ROI before clockwise rotation (pixel-verified)",
  );
  // Dedicated-worker failure/cancellation behavior.
  const modelFailure = await page.evaluate(async () => {
    const w = new Worker("/scan-lab/ocr-host.mjs", { type: "module" });
    return await new Promise((resolve) => {
      w.onmessage = ({ data }) => {
        if (data.type === "error") {
          w.terminate();
          resolve(data.error);
        }
      };
      w.postMessage({ id: 1, type: "init", engine: "invalid" });
    });
  });
  assert.match(modelFailure, /Unknown engine/);
  results.checks.push("Worker reports initialization failures explicitly");
  // Scope/privacy guards inspect only this bounded package.
  const requests = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map((r) => new URL(r.name).pathname),
  );
  assert.ok(requests.every((p) => !p.startsWith("/api/")));
  results.checks.push("Harness inference made no app API/WMS request");
  // Actual React unmount must release a running camera.
  await page.getByRole("button", { name: "Start Camera", exact: true }).click();
  await page.waitForFunction(
    () => !!document.querySelector("video")?.srcObject,
  );
  const ended = await page.evaluate(() => {
    const track = document.querySelector("video").srcObject.getVideoTracks()[0];
    window.scanLabTest.unmount();
    return track.readyState;
  });
  assert.equal(ended, "ended");
  results.checks.push(
    "React navigation/unmount cleanup stops actual MediaStream tracks",
  );
  console.log(
    JSON.stringify(
      {
        checks: results.checks,
        measurements: results.measurements.map((a) => ({
          fixture: a.fixture,
          status: a.status,
          outputs: a.outputs.map((o) => ({
            engine: o.engine,
            text: o.rawText,
            initMs: o.initMs,
            inferenceMs: o.inferenceMs,
          })),
        })),
        camera: results.camera,
        errors: results.errors,
      },
      null,
      2,
    ),
  );
} catch (e) {
  results.failure = e.stack;
  throw e;
} finally {
  await writeFile(
    join(output, "browser-receipt.json"),
    JSON.stringify(results, null, 2),
  );
  await context?.close();
  await browser.close();
  await new Promise((r) => server.close(r));
}
