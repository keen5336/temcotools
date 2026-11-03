# TemcoTools v2 — Experimental WASM Scanning Lab

Implementation handoff for GPT Work to Codex
Date: November 3, 2026
Status: Approved concept; implement as an isolated experiment first
Working name: TemcoScan Lab (name provisional)

This file preserves the complete owner handoff supplied to the implementation agent on November 3, 2026. Implementation evidence and deviations belong in the companion implementation document; preserve this handoff as provenance.

## 1. Executive decision

Add a DWDemo-style experimental scanning utility INSIDE TemcoTools v2 to evaluate web barcode scanning and printed-text OCR on Zebra handhelds, ordinary Android phones, iPhones, tablets, desktops. Central concept browser-controlled live camera plus on-device recognition, with WASM OCR/software barcode decoding. Compact persistent inline camera preview does NOT take over whole screen. Large Scan/Capture and optional continuous detection. Test bench, not production WMS: no put-away, inventory adjustment, order updates or any WMS mutation. Establish feasibility, accuracy, throughput, handling, constraints/performance before operational integration.

Why: DataWedge15.0.9 free-form OCR/frame streaming behavior was visible in Zebra DWDemo; equivalent OCR delivery did not work as expected in ordinary browser text field/Temco workflow, and dedicated trigger did not act as OCR capture trigger. Observation, NOT proof Zebra cannot integrate with browser. Use browser camera/frame extraction/local recognition without depending on DataWedge OCR. Browser rear camera may be photographic camera, NOT dedicated barcode imager; enumerate actual exposed getUserMedia cameras.

## 2. What to learn

(1) Zebra persistent inline Chrome live feed/camera switching. (2) WASM OCR accuracy on serial/model/LPN/small labels. (3) ROI effect on performance/accuracy. (4) Camera barcode speed credibility compared to hardware for some workflows. (5) Reliability, latency, battery/heat, initialization, ergonomics vs hardware wedge. (6) Optional hybrid barcode+text from same image. (7) Reusable modules. Do NOT assume parity with Zebra hardware. Measure; dedicated imager has optimized optics, aiming, illumination, ergonomics, decoding.

## 3. Scope/UX

### 3.1

Existing utilities/tools area, inspect real repo/routing/auth/nav/flags first, don't assume structure. Clearly Experimental / No WMS writes. Admin-only PLATFORM-admin route/nav/API (not site managers). Touch-first Zebra, responsive phone/desktop.

### 3.2 DWDemo-style one screen

- Compact live camera stays active during scanning/results; expandable/collapsible, no forced fullscreen.
- Draggable/resizable visible ROI + full-frame; practical per-device/camera ROI preference.
- Start/Stop Camera, Scan/Capture, Clear, Switch Camera, optional Torch ONLY if track supports it.
- Status: camera permission, active camera/source, requested vs actual resolution, engine/model readiness, decoding, errors.
- Last Result: raw, normalized candidate, barcode format/OCR line, confidence ONLY available, box, total elapsed/time stamp.
- Scrollable session history of successes/attempts/duplicates/errors/manual corrections.
- Manual and continuous; debounce duplicates; no unbounded inference.
- Image upload/captured-frame replay for SAME input comparisons.
- Local JSON/CSV exports privacy-safe by default; session clear/reset.

### 3.3 Three independent choices

Input = camera rear/front/other, optional existing hardware keyboard-wedge benchmark, or still upload/replay.
Task = barcode, OCR, hybrid barcode+OCR same image (may follow baseline).
Capture = manual on-screen or throttled continuous with visible pause/history.
Normal phone camera path must work without any Zebra software.

## 4. Recommended implementation

### 4.1 Camera

getUserMedia video/audio:false HTTPS, normal inline video autoplay/muted/playsinline; canvas.drawImage/frame API. Default facingMode ideal environment; enumerateDevices after permission, explicit deviceId selection. Switch releases old tracks/reacquires cleanly. Resolution presets and actual track.getSettings (not assumed constraints). Runtime track.getCapabilities before torch/zoom/focus controls; unsupported must not break scanning. Handle permission denied, no/in-use camera, sleep/background, orientation, interruptions, navigation/unmount. Correct displayed-preview ROI -> original frame geometry for aspect-fit/crop, front mirror and orientation. Crop BEFORE expensive OCR.
Boundary: DataWedge Imager Frames Streaming uses Android intents/content URIs, not browser MediaStream; dedicated-imager native bridge is OUT OF SCOPE. Standard rear camera enough for experiment.

### 4.2 Barcodes

feature detect native BarcodeDetector + supported formats, not universal. Actual cross-browser ZXing software fallback (@zxing/browser etc). Prioritize Code128, common1D/QR; additional formats from samples, don't invent support. Capture raw value/format/timing/box where supplied, duplicate/validation outcomes. Optional wedge isolated capture input handles prefix/suffix/Enter; test scans cannot trigger other operational actions.

### 4.3 OCR swappable SAME-frame backends

1 Tesseract.js real WASM printed-alphanumeric baseline.
2 PaddleOCR.js @paddleocr/paddleocr-js real candidate, ONNX Runtime Web WASM, detection+recognition text locations/scores, mobile-appropriate model initially.
3 WebGPU optional AFTER WASM baseline; never call WebGPU WASM performance.
Expensive inference in dedicated Web Worker where supported; visible model download/compilation/init progress and separate timings. One in-flight OCR per worker or bounded queue; stale continuous frames discarded, not latency backlog.
Manual single frame first, then throttled continuous. Optional transforms crop/resize/contrast/grayscale/threshold/rotation for comparison; keep originals unmodified for A/B.
Show complete raw text, lines/boxes and confidences as supplied, optional LPN/serial/model extraction. Never silently O/0 I/1 S/5 substitution. Regex/high-confidence isn't identity proof; uncertain extraction requires operator confirmation.

### 4.4 Reusable boundaries

CameraSource/FrameSource -> FrameCapture/ROI/preprocessing -> recognizer interface -> NativeBarcode, ZXingBarcode, TesseractOCR, PaddleOCR -> normalized result -> Lab UI/metrics/export. Conceptual result id,timestamp,source,cameraId,task,engine,rawText,normalizedText?,symbology?,confidence?,boundingBox?,frameSize?,roi?,timings?,validation?,isDuplicate?,confirmed?. Separate barcode/OCR, preserve raw, engine/source, only real confidence, multiple results/frame. Do not impose separate data platform.

## 5. Test/benchmark

### 5.1 Actual device manual matrix

actual Temco Zebra exact model/Android/Chrome or Enterprise Browser/DataWedge15.0.9/exposed cameras; ordinary Android Chrome; iPhone Safari if available; desktop webcam/upload. NO Zebra compatibility claims without real unit.

### 5.2 Authorized representative synthetic/de-identified fixture set with ground truth

- clean serials, small dense serials/LPN/shelf-location/model labels.
- curved/reflective/shadows/low-light/glare/angles/motion/damage/small text.
- 0/O 1/I 5/S 8/B missing/extra dashes/case/leading zeros.
- multiple fields/barcodes per frame.
- duplicates removed/reintroduced continuous.
NO real customer/operational images to third-party OCR. Fabricated/de-identified preferred.

### 5.3 Metrics per device/source/engine/resolution/ROI

- first model bytes/download time; cold/warm init.
- camera startup, actual capture resolution/FPS.
- preprocess/inference/end-to-end capture->visible median/p95 only adequate sample.
- barcode exact match/read success/false positives/time-to-first-valid.
- OCR exact field match/CER when measurable, omissions/misreads, correction rate.
- manual/continuous scans per minute and duplicates.
- memory trend/CPU/heat/battery ONLY measurable; browsers not precise power meters.
- camera/engine errors/recovery.
Side-by-side comparison/table and local JSON/CSV including ground truth, no server storage requirement.

### 5.4 Experiments

full-frame vs ROI; 640/720/1080 supported resolutions; native vs ZXing; Tesseract vs Paddle SAME saved frames; SIMD/threads only supported and document headers; manual vs1-5fps conservative continuous; rear vs other Zebra exposed cameras; optional hardware barcode baseline. NO speculative speed claims.

## 6. Privacy/deployment

No WMS/API writes; outputs/history local experimental only, no operational action or guessed identities. Local inference by default, no external OCR APIs; vet/pin model/runtime assets, preferably same pilot origin, document versions/origins/licenses. No automatic raw-picture storage; retention/export explicit opt-in, session-local default + manual clear, minimize sensitive logs/exports. Camera HTTPS/user permission, don't assume embedded frames work. Handle missing BarcodeDetector/camera/SIMD/threads, connectivity/model download failures gracefully. Workers only needed, stop tracks/dispose recognizers on exit. Single-thread WASM fallback; don't globally weaken headers to enable threads. Offline/PWA only AFTER baseline; explicit asset caching/airplane-mode proof, no offline promise solely from local inference. Lazy large downloads so ordinary app users don't pay lab bundle.

## 7. Milestones

M0 inspect/plan/licenses, avoid unrelated refactor.
M1 inline camera, permissions/recovery/cameras/compactpreview/startstopcapture/ROI/crop/uploadreplay/status, ordinary mobile Chrome noDataWedge.
M2 native/ZXing real decoder, manual/throttledcontinuous/history/duplicates/fixtures.
M3 real worker Tesseract then Paddle where compatible, raw OCR/boxes/crop/extractionconfirm/init/per-frame timings.
M4 same-frame A/B per-device metrics/export/docs/checklist/fixtures/robustnesscleanup.
M5 justified stretch only: PWA/hybrid/advancedcontrols/hardwarewedge/modeltuning. Don't delay usablelab.

## 8. First useful release acceptance

1 Mobile Chrome permission and embedded live preview nofullscreen.
2 Enumerate/switch actual cameras and graceful failures; actual settings/capabilities.
3 ROI move/resize corresponds to correct captured crop.
4 Big capture runs FULLY LOCAL OCR, raw+timing.
5 Actual camera/software barcode decoder independent of DataWedge normalphone.
6 Baseline Tesseract and candidate Paddle SAME sample or actual investigated technical/device compatibility blocker visible honestly. Do not dismiss Paddle without trying an evidenced viable route.
7 Manual/continuous bounded backlog/duplicates/no stuck camera after navigation.
8 History successes/errors/engine/source/timings/export/clear.
9 Automated meaningful ROI geometry/aspect/rotation/mirror/letterbox, normalization, duplicates, extraction validation, real still-image inference, auth denied, cancellation/backpressure/unmount/navigation/model failure, mobileUI. Real browser/software-camera fixtures; compile/lint/build/deploy. Never report emulation as physical hardware.
10 ZERO WMS mutation possible from lab.
11 Exact files/tests/build/limits and real-device steps, actual measurements pending if absent.

## 9. Orchestration

Implement inside existing TemcoTools v2 after orientation. Coherent bounded agents only, no conflicting shared writers. Drive past scaffold through safe unblocked software implementation. Device absence only blocks physical qualification, not software lab. Feature isolated, working utilities preserved, no speculative WMS integrations. Deliver functional lab, meaningful tests, demo/device instructions, benchmark exports, succinct findings/next based on measured evidence. Deploy only approved isolated v2 path (coordinator). Admin-only experimental restrictions; do not enable general warehouse operations.

## 10. Deferred

Replacing WMS UI/putaway/prodbarcode/fleet; Descartes/MARS/PODWeb/prodinventory writes; dedicated Zebra imager Android nativebridge; custom modeltraining/superiority claims; all-purpose external scanning service or recognition backend.

## 11. Primary technical references to actually consult

https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/enumerateDevices
https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints/facingMode
https://developer.mozilla.org/en-US/docs/Web/API/Media_Capture_and_Streams_API/Taking_still_photos
https://developer.mozilla.org/en-US/docs/Web/API/Barcode_Detection_API
https://github.com/zxing-js/browser
https://github.com/naptha/tesseract.js
https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/inference_deployment/cross_platform/browser.en.md
https://github.com/PaddlePaddle/PaddleOCR/blob/main/paddleocr-js/packages/core/README.md
https://techdocs.zebra.com/datawedge/15-0/guide/input/workflow/

Guiding principle: useful MEASUREMENT INSTRUMENT first. Promote reusable capture/recognition into production workflows only after real-device evidence; do not automatically wire experimental OCR into Receiving.
