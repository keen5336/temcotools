# TemcoScan Lab implementation handoff — November 3, 2026

Coordinator status: the historical specialist integration hooks below are completed on `v2`: real platform guard/route/nav/shared MCP handoff, full-app/deployed both-engine checks and same-origin assets. Current native pin and physical-device limits are in [build status](build-status.md). Do not recreate a stub guard or restart the delivered scanner assignment.

The bounded package is a functional client-only scanning experiment. It makes no WMS/API writes, imports no application actions/auth/Prisma modules, and requires no new server endpoint. The immutable [owner handoff](temcoscan-owner-handoff.md) is preserved separately.

## Nov5 field feedback and capture ergonomics

Adam reported: “Temco Scan lab so far has been a HUGE success by the way, it works amazing.” This is positive owner field feedback; no device model, engine, measured accuracy/latency or comprehensive hardware acceptance was supplied. His concrete issue was scrolling between the live view and Capture while holding a device steady. This is lab ergonomics, not a production workflow change.

This increment keeps the one existing video/MediaStream and ROI transforms. While the camera is active, its container becomes a compact bottom dock with preview, adjacent large Capture and reachable Stop, safe-area bottom padding, constrained dynamic-viewport height and compact/expand/collapse controls. The inline slot retains its height; measured dock height reserves bottom space for scrollable settings/history. Keyboard focus is revealed without moving pointer checkbox targets during a click. ROI numeric controls stay in settings; ROI drag remains on the same stage, without panel drag gestures.

Only the dock's intentional single **Capture** opens a native accessible review dialog. It carries that attempt's success/miss/error, raw detections/candidates and a temporary thumbnail of the **already encoded processed Blob**, including ROI/transforms. There is no recapture, additional review encode, upload or history image attachment. The separate opt-in original-frame replay retention keeps its existing behavior. Closing/Escape/**Back to camera / scan again** releases its object URL and returns focus to Capture without restarting the camera. Cancel/stop/background/unmount release the review; the existing SingleFlight generation gate suppresses late/cancelled results. Continuous captures, uploads, wedge and the existing manual compare remain in normal result/history flow and do not open this review. Engines, data, auth and operational behavior are unchanged.

Focused validation and exact deployed source are recorded in [build status](build-status.md). The real app test uses the existing synthetic camera Y4M and real ZXing, not a real handheld. It covers phone and short-landscape bounds, one video/stream, same-attempt thumbnail/result with one encode, focus, ROI, miss/error, cancellation/background handler, continuous/no-dialog, upload/wedge and navigation. Public mode additionally checks anonymous/site-manager denial, preserved WMS setup and exact runtime pins, then removes its own temporary people/sites/sessions. No owner account is used.

**Owner check on the actual handheld:** open [TemcoScan Lab](https://temco-v2.chronchive.com/tools/scan-lab), start the camera, aim and tap Capture without scrolling; dismiss review and immediately capture again. Try portrait/landscape, compact/collapse, an ROI drag and Stop with your normal grip/browser bars. Confirm dock size/thumb reach and label legibility. This new ergonomics check remains pending physical feedback; the positive observation above does not retroactively qualify the new layout.

## Coordinator integration

Default export: `components/scan-lab/ScanLabClient.tsx` (no props). Create the server route and navigation under the new **real platform-admin** principal/guard. Do not use the legacy manager/site-admin role:

```tsx
import { requirePlatformAdmin } from "@/lib/auth/platform";
import ScanLabClient from "@/components/scan-lab/ScanLabClient";
export default async function ScanLabPage() {
  await requirePlatformAdmin();
  return <ScanLabClient />;
}
```

The guard above is an integration contract, not an implementation or assertion that the guard exists in this branch. The coordinator owns the guard, `/tools/scan-lab`, nav/registry, MCP human/device handoff/config, root manifests, full application build, denied-user tests, and isolated v2 deployment. This branch does not create a route, change auth, edit root manifests, deploy, or open a PR. Before exposure, verify anonymous, site-manager, warehouse-admin and non-platform-admin users cannot render the route or discover its nav item. A passing standalone harness does not prove that boundary.

Build and distribute static files from `public/scan-lab/`, including the generated ignored `vendor/` directory, on the same pilot origin. URLs are rooted at `/scan-lab/`; no CDN or external OCR service is called by the lab. Static engine assets are inert public files; all operational access is through the coordinator's guarded page. There is no API route to guard. Do not add a recognition backend or wire results into Receiving.

## Exact dependencies and distribution

The root app needs **zero additional npm imports** for this package: React is already present; recognition loads static ES modules at capture time. Keep the isolated runtime package and its lockfile as a build input. If the coordinator prefers root build dependencies instead, use the same exact pins and preparation step; do not rely on floating Paddle/ORT ranges.

| Package | Exact version | License / purpose |
| --- | --- | --- |
| `@paddleocr/paddleocr-js` | 0.4.2 | Apache-2.0; official browser SDK and published worker |
| `onnxruntime-web` | 1.24.3 | MIT; **must match the runtime embedded in Paddle's published worker** |
| `@techstark/opencv-js` | 4.10.0-release.1 | Apache-2.0; OpenCV plus third-party notices |
| `clipper-lib` | 6.4.2 | Boost Software License (npm metadata calls this `BSL`) |
| `js-yaml` | 4.3.2 | MIT |
| `tesseract.js`, `tesseract.js-core` | 7.0.0 each | Apache-2.0; English LSTM baseline, worker and SIMD/non-SIMD cores |
| `@tesseract.js-data/eng` | 1.0.0 | Package MIT; upstream traineddata Apache-2.0, both notices retained |
| `@zxing/browser` | 0.2.1 | MIT |
| `@zxing/library` | 0.23.0 | Apache-2.0 |
| `esbuild` | 0.25.12 | MIT; build only |

Authoritative exact manifests: `scripts/scan-lab/runtime-package.json`, `scripts/scan-lab/runtime-package-lock.json`. Models, official origin URLs, byte counts and SHA-256 pins: `scripts/scan-lab/model-assets.json`. The official PP-OCRv5 mobile detection tar is 4,843,520 bytes and recognition tar is 16,701,440 bytes, Apache-2.0. English model comes from the pinned npm distribution's `4.0.0/eng.traineddata.gz`. No model or large runtime binary is checked into Git.

`scan-lab-prepare.mjs` validates installed versions, bundles the published SDK/worker without modifying recognition code, copies the matching ORT loaders/binaries and Tesseract cores, checks every model digest, and emits `vendor/asset-manifest.json` plus full notices. It retains verified model downloads in the sandbox cache between preparations. Generated vendor output is about 118 MB uncompressed in this qualification; a browser downloads only the engines/core it actually uses. Do not fetch or initialize these assets globally in the app shell.

The package includes full Paddle/Tessdata Apache notices and OpenCV COPYRIGHT under `public/scan-lab/licenses/`. Preparation also gathers dependency LICENSE/NOTICE files and linked bundle license notices. Preserve these files in deployment. Synthetic PNGs and ground truth are CC0-1.0; no font files, customer photographs, credentials or operational data are distributed.

### Reproduce runtime preparation on this Mac

Use a verified mounted MacDev destination; no internal fallback. From the external checkout:

```sh
dev-storage status
SCAN_LAB_SANDBOX=/Volumes/MacDev/ProjectArchive/Development/Qualification/temcoscan-runtime
mkdir -p "$SCAN_LAB_SANDBOX"
cp scripts/scan-lab/runtime-package.json "$SCAN_LAB_SANDBOX/package.json"
cp scripts/scan-lab/runtime-package-lock.json "$SCAN_LAB_SANDBOX/package-lock.json"
dev-run -- npm ci --prefix "$SCAN_LAB_SANDBOX" --no-audit --no-fund
export SCAN_LAB_SANDBOX
dev-run -- node scripts/scan-lab-prepare.mjs
```

For Linux/Docker pilot builds, the coordinator can use an isolated build-stage directory with these same manifests, set `SCAN_LAB_SANDBOX`, run preparation, then copy the complete public directory into the final image. Preparation must succeed before deployment. Do not assume Git checkout alone contains the ignored runtime assets. The script replaces only its generated `public/scan-lab/vendor/` directory; it does not install or edit the root package.

### Runtime investigation and actual Paddle route

The official SDK documents `worker: { createWorker }`, explicit model asset URLs, and `backend: "wasm"`. Its published 0.4.2 browser constructor overwrites a supplied image adapter with a DOM adapter; the attempted direct worker construction failed with `document is not defined`. The implemented route uses its **official published worker** and documented worker factory instead.

That worker embeds ONNX Runtime Web **1.24.3** despite the package's `^1.22.0` dependency range resolving to newer versions. Using 1.31.1 loader assets failed; the corrected pin and matching `ort-wasm-simd-threaded.jsep.*` assets completed real inference. `jsep` / `threaded` in the filename is not evidence of WebGPU or multithreaded execution: the lab forces `backend: "wasm"`, `numThreads: 1`, `proxy: false` and records both actual providers. The successful receipt reports `wasm` for detection and recognition, with GPU disabled and no COOP/COEP headers.

`paddle-host.mjs` buffers the initialization message while dynamically importing the published worker; without that buffer the first message could be lost. Its fetch wrapper measures bytes/download time and denies external origins. Tesseract's classic worker wrapper measures English model download and keeps all assets on origin. Recognition algorithms, weights and confidences come from the real packages. Neither wrapper invents an engine, score or benchmark.

## Delivered behavior and boundaries

- Camera: explicit permission/start/stop, rear preference, post-permission camera enumeration, exact device selection, requested presets and actual settings/FPS/capabilities, supported torch only. Switching stops old tracks. Background/pagehide, interruption and unmount stop tracks and workers; restart is explicit. A video resize updates intrinsic geometry after orientation changes.
- Preview: inline muted autoplay/playsInline, compact/expand/collapse without fullscreen. ROI drag/resize plus accessible numeric controls; normalized unmirrored source coordinates account for contain letterboxing and front-camera mirroring. Optional per-camera/resolution localStorage ROI preference stores geometry only. Full frame is default.
- Frames: canvas capture, crop before resize/contrast/grayscale/threshold/clockwise rotation; original remains unchanged. Explicit upload or opt-in last-camera-frame retention permits replay. The compare button encodes one processed PNG and sends **that same Blob** to both engines, with one frame hash. Images are not attached to history or normal exports.
- Recognition: native BarcodeDetector with supported-format detection and ZXing fallback; ZXing Code128/QR are actually qualified. Its current fallback returns one barcode per crop; native may return several. Use ROI on a multi-barcode sample. Barcode confidence is absent. Real OCR lines, native boxes/Tesseract boxes/Paddle polygons and confidence scales are retained; geometry is in processed-frame pixels.
- Execution: manual or conservative target 1–5 FPS continuous camera capture. One admission, no queued frames; timer waits for completed recognition plus the interval. Cancel invalidates late results and terminates the engine worker trees. Initialization/inference and barcode calls have deadlines. A canceled comparison checks validity before starting another engine. No automatic retry after failure.
- Results: raw text unchanged, separate whitespace-normalized candidate, conservative labelled-field extraction always requiring operator confirmation, correction stored separately, exact engine/source/timestamp/geometry/timings, duplicates marked within a 3-second window, cap of 200 attempts. A high score never establishes label identity.
- Metrics: grouped by engine/source/camera/resolution/ROI/transform; cold initialization and per-engine inference recorded separately; capture/preprocess/total and next-animation-frame visible estimate retained. In a paired comparison, total includes both engines. Median requires ≥5 measurements and p95 ≥20; render-frame timing estimates do not measure display hardware. Ground-truth exact match/CER use raw text, including whitespace, so a trailing newline counts. Correction/confirmation counts are available. Wedge delivery is untimed and excluded from latency percentiles.
- Export: local JSON/CSV default to omitting raw/normalized text, ground truth, corrections, freeform notes, error detail, camera identifiers and images. Explicit text opt-in enables those textual fields; images still require the separate Save Frame action. Runtime export retains only whitelisted versions/providers and local asset byte/download measurements. CSV formulas are escaped. Model download measurements from loopback are not WAN/network benchmarks.
- Wedge: isolated focused prefix/suffix/Enter capture; no document-wide hotkey or operational action. Keyboard delivery does not reveal hardware imager decode latency.

## Qualification and remaining acceptance

Run `scripts/scan-lab.test.ts` with `tsx --test`. Thirteen meaningful unit tests cover contain/cover/letterbox/mirror/rotation ROI mappings, pixel bounds, identity-preserving normalization, extraction validation, duplicate expiry, CSV/privacy, CER, percentile gates, zero-backlog cancellation, late camera grants, switching, permission/enumeration failures, unsupported torch, worker concurrent dispatch/cancellation, and untimed wedge exclusion.

The actual browser harness is `scripts/scan-lab-browser.mjs`; use the isolated test dependency manifest `scripts/scan-lab/qualification-package.json`. It bundles the **production component and capture functions**, serves loopback-only static files, denies external browser requests, and drives real Chrome with a deterministic Y4M camera through getUserMedia. No app/database connection is made. Default browser channel is installed Google Chrome; `SCAN_LAB_BROWSER_CHANNEL` can select another Playwright-supported installed channel. A newly installed headless-shell build hung on text canvas rendering in this environment; system Chrome completed the same checks. Failed diagnostics remain in MacDev Qualification.

```sh
# After installing the isolated qualification dependencies and preparing assets:
export SCAN_LAB_SANDBOX=/Volumes/MacDev/ProjectArchive/Development/Qualification/temcoscan-lab-20261103
dev-run -- "$SCAN_LAB_SANDBOX/node_modules/.bin/tsx" --test scripts/scan-lab.test.ts
dev-run -- node scripts/scan-lab-browser.mjs --matrix
# --fixtures deliberately regenerates the synthetic committed inputs.
```

Automated software result: **13 unit tests and 17 real Chrome checks passed**, plus **18 actual OCR inferences on nine simulated label conditions**. A minified React production bundle and a separate **Next.js 16.4.3 optimized webpack build with TypeScript** of the standalone component passed. Scoped ESLint passed; its only output was a React auto-detection environment warning because this checkout intentionally has no root node_modules. The original application and its guarded route were not built or deployed by this helper.

The [sanitized software receipt](temcoscan-software-receipt.json) binds tested source hashes and records the checks, real raw outputs, actual providers, download measurements and limitations. The [asset inventory](temcoscan-asset-manifest.json) records generated runtime file bytes and SHA-256 hashes. The companion software receipt contains real inference outputs, model downloads and per-frame timings, including misreads. It is **software qualification, not physical hardware acceptance**. Do not infer speed superiority, Zebra compatibility, iPhone behavior or production readiness from it. Threshold sample sizes are intentionally not met for p95 in this small run.

Known limits: physical Zebra/exact Android/Chrome/DataWedge, ordinary Android, iPhone Safari, real camera switching/torch, permission UX on those devices, thermal/battery/memory trends, long sessions and sustained throughput remain manual qualification. Paddle requires worker OffscreenCanvas/ImageBitmap and the shipped runtime's SIMD support; failures are visible and Tesseract's non-SIMD core remains available where supported. No WebGPU option, custom training, PWA/offline promise, native DataWedge bridge, camera hardware trigger binding, zoom/focus UI or operational promotion is implemented. ZXing is canvas-based software decoding on the main thread; OCR runs off-thread.

Full application type/build, real platform-admin denial, registry/MCP configuration and isolated v2 deployment must be run by the coordinator after integration. The helper's successful component bundle/typecheck/lint/browser tests do not replace those checks.

## Device acceptance checklist

1. Record exact unit model, OS, browser/version, DataWedge version, exposed cameras, requested/actual resolution/FPS and lighting in session notes; distinguish browser camera from dedicated imager.
2. Open the guarded pilot route over HTTPS as platform admin. Verify all denied roles before granting navigation. Allow camera; confirm persistent inline preview, no fullscreen, stop/restart and permission-denied recovery.
3. Enumerate/switch every exposed camera; confirm old tracks stop and actual settings change. Rotate device; crop the same visible target with ROI. Test mirrored front preview, compact/expanded/letterboxed view and torch only where exposed.
4. Start with the committed synthetic clean serial, dense LPN/location and ambiguity strings. Replay identical originals full-frame and ROI at supported 640/720/1080 presets. Run Tesseract, Paddle and same-Blob compare; preserve errors, raw mistakes and scores.
5. Test Code128, QR and both crops of the multi-barcode fixture, then authorized de-identified real labels. Compare native and ZXing only where native is available. Blank/damaged labels must not be treated as confirmed identities.
6. Collect enough warm/manual/continuous samples per exact condition for median/p95. Remove/reintroduce a label after the duplicate window. Measure actual completion rate over a declared observation window; target FPS is not throughput. Retain failures/corrections. Never claim power or heat without an actual measurement method.
7. Interrupt permission, disconnect a camera, background/lock/unlock, navigate away, deny model assets and cancel initialization. Confirm bounded errors, stopped tracks/workers, no late history resurrection and explicit restart recovery.
8. Export default JSON/CSV and inspect redaction; opt into synthetic text only to inspect ground truth/CER. Save pictures only intentionally. Clear session and reset. No WMS request or operational action may occur.

## Primary sources consulted

- Camera security, facing mode, actual frame capture and enumeration: [getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia), [enumerateDevices](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/enumerateDevices), [facingMode](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints/facingMode), [still photos](https://developer.mozilla.org/en-US/docs/Web/API/Media_Capture_and_Streams_API/Taking_still_photos).
- Native barcode feature detection: [Barcode Detection API](https://developer.mozilla.org/en-US/docs/Web/API/Barcode_Detection_API). Software decoding and licensing: [ZXing browser source](https://github.com/zxing-js/browser), published npm package/source installed in the sandbox.
- Tesseract actual worker/core API: [official repo](https://github.com/naptha/tesseract.js), [API reference](https://github.com/naptha/tesseract.js/blob/master/docs/api.md), [English data source](https://github.com/naptha/tessdata).
- Paddle browser deployment, results/confidences and documented worker factory: [browser deployment](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/inference_deployment/cross_platform/browser.en.md), [SDK README](https://github.com/PaddlePaddle/PaddleOCR/blob/main/paddleocr-js/packages/core/README.md), published 0.4.2 source maps/worker inspected directly. Official model URLs/digests are pinned in the manifest.
- The DataWedge observation does not establish browser incompatibility: [Zebra Workflow Input 15.0](https://techdocs.zebra.com/datawedge/15-0/guide/input/workflow/). Android intent/content-URI imager streaming is a separate native integration and remains out of scope.
