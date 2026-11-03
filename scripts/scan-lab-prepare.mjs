/** Run after npm ci in an isolated sandbox using scripts/scan-lab/runtime-package{,-lock}.json. */
import { createRequire } from "node:module";
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  copyFile,
  stat,
  rm,
} from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = process.env.SCAN_LAB_SANDBOX;
if (!sandbox)
  throw new Error(
    "Set SCAN_LAB_SANDBOX to an installed isolated runtime package directory",
  );
const requireRuntime = createRequire(join(resolve(sandbox), "package.json"));
const manifest = JSON.parse(
  await readFile(join(root, "scripts/scan-lab/runtime-package.json"), "utf8"),
);
for (const [name, version] of Object.entries(manifest.dependencies)) {
  const installed = JSON.parse(
    await readFile(join(sandbox, "node_modules", name, "package.json"), "utf8"),
  );
  if (installed.version !== version)
    throw new Error(`${name}: expected ${version}, got ${installed.version}`);
}
const { build } = requireRuntime("esbuild");
const out = join(root, "public/scan-lab/vendor");
const pins = JSON.parse(
  await readFile(join(root, "scripts/scan-lab/model-assets.json"), "utf8"),
);
const modelCache = join(sandbox, "temcoscan-model-cache");
await mkdir(modelCache, { recursive: true });
for (const model of pins) {
  try {
    const data = await readFile(join(out, model.path));
    if (createHash("sha256").update(data).digest("hex") === model.sha256)
      await writeFile(join(modelCache, model.model + ".tar"), data);
  } catch {}
}
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const modulePath = (name) => join(sandbox, "node_modules", name);
const paddleDist = modulePath("@paddleocr/paddleocr-js");
const paddleWorker = (await readdir(join(paddleDist, "dist/assets"))).find(
  (name) => /^worker-entry-.*\.js$/.test(name),
);
if (!paddleWorker) throw new Error("Published Paddle worker asset missing");
await build({
  entryPoints: {
    ...Object.fromEntries(
      ["tesseract", "paddle", "zxing"].map((name) => [
        name,
        join(root, `lib/scan-lab/runtime/${name}.mjs`),
      ]),
    ),
    "paddle-worker": join(paddleDist, "dist/assets", paddleWorker),
  },
  outdir: out,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  minify: true,
  splitting: true,
  nodePaths: [join(sandbox, "node_modules")],
  alias: {
    "onnxruntime-web": join(
      modulePath("onnxruntime-web"),
      "dist/ort.wasm.min.mjs",
    ),
  },
  external: ["fs", "path"],
  legalComments: "linked",
});
async function copy(source, dest) {
  await mkdir(dirname(join(out, dest)), { recursive: true });
  await copyFile(source, join(out, dest));
}
await copy(
  join(modulePath("tesseract.js"), "dist/worker.min.js"),
  "tesseract/worker.min.js",
);
for (const file of await readdir(modulePath("tesseract.js-core")))
  if (file.endsWith(".wasm.js"))
    await copy(
      join(modulePath("tesseract.js-core"), file),
      `tesseract/core/${file}`,
    );
await copy(
  join(modulePath("@tesseract.js-data/eng"), "4.0.0/eng.traineddata.gz"),
  "tesseract/lang/eng.traineddata.gz",
);
for (const suffix of ["", ".jsep"])
  for (const ext of ["mjs", "wasm"])
    await copy(
      join(
        modulePath("onnxruntime-web"),
        `dist/ort-wasm-simd-threaded${suffix}.${ext}`,
      ),
      `ort/ort-wasm-simd-threaded${suffix}.${ext}`,
    );
for (const model of pins) {
  const target = join(out, model.path);
  await mkdir(dirname(target), { recursive: true });
  let data;
  try {
    data = await readFile(join(modelCache, model.model + ".tar"));
  } catch {}
  if (
    !data ||
    createHash("sha256").update(data).digest("hex") !== model.sha256
  ) {
    console.log(`Downloading official model ${model.path}`);
    const response = await fetch(model.url, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Model HTTP ${response.status}`);
    data = Buffer.from(await response.arrayBuffer());
  }
  const hash = createHash("sha256").update(data).digest("hex");
  if (hash !== model.sha256)
    throw new Error(
      `Model digest mismatch for ${model.path}; expected ${model.sha256}, got ${hash}`,
    );
  await writeFile(target, data);
  await writeFile(join(modelCache, model.model + ".tar"), data);
}
const notices = [];
for (const name of await readdir(join(root, "public/scan-lab/licenses")))
  await copy(join(root, "public/scan-lab/licenses", name), `licenses/${name}`);
for (const [name, version] of Object.entries(manifest.dependencies)) {
  const pkg = JSON.parse(
    await readFile(join(modulePath(name), "package.json"), "utf8"),
  );
  notices.push(
    `${name}@${version} — ${pkg.license}\n${JSON.stringify(pkg.repository ?? pkg.homepage ?? "")}\n`,
  );
  for (const file of await readdir(modulePath(name)))
    if (/^(licen[cs]e|copying|notice)(\.|$)/i.test(file)) {
      const text = await readFile(join(modulePath(name), file), "utf8");
      notices.push(text);
    }
}
notices.push(
  "PaddleOCR PP-OCRv5 mobile model origin and SHA-256: " +
    JSON.stringify(pins, null, 2),
);
notices.push(
  "PaddleOCR (Apache-2.0): https://github.com/PaddlePaddle/PaddleOCR/blob/main/LICENSE\nTesseract English traineddata upstream (Apache-2.0): https://github.com/tesseract-ocr/tessdata/blob/main/LICENSE\nOpenCV third-party notices: https://github.com/opencv/opencv/blob/4.10.0/COPYRIGHT",
);
await writeFile(join(out, "THIRD-PARTY-NOTICES.txt"), notices.join("\n\n"));
const files = [];
async function inventory(dir) {
  for (const name of await readdir(dir)) {
    const path = join(dir, name),
      s = await stat(path);
    if (s.isDirectory()) await inventory(path);
    else if (name !== "asset-manifest.json") {
      const b = await readFile(path);
      files.push({
        path: path.slice(out.length + 1),
        bytes: b.length,
        sha256: createHash("sha256").update(b).digest("hex"),
      });
    }
  }
}
await inventory(out);
files.sort((a, b) => a.path.localeCompare(b.path));
await writeFile(
  join(out, "asset-manifest.json"),
  JSON.stringify(
    { runtime: manifest.dependencies, models: pins, files },
    null,
    2,
  ),
);
console.log(
  `Prepared ${files.length} same-origin assets, ${files.reduce((n, f) => n + f.bytes, 0)} bytes at ${out}`,
);
