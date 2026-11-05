"use client";

import { useEffect, useRef } from "react";
import { extractCandidates } from "../../lib/scan-lab/results";
import type { Attempt } from "../../lib/scan-lab/types";
import styles from "./scan-lab.module.css";

export default function CaptureReview({ attempt, frameUrl, onDismiss }: {
  attempt: Attempt; frameUrl?: string; onDismiss: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className={styles.review} aria-labelledby="scan-capture-review-title"
    aria-describedby="scan-capture-review-status" data-attempt-id={attempt.id}
    onCancel={e => { e.preventDefault(); onDismiss(); }}>
    <div className={styles.reviewHeader}>
      <h2 id="scan-capture-review-title">Capture review</h2>
      <button type="button" onClick={onDismiss} aria-label="Close capture review">Close</button>
    </div>
    <div className={styles.reviewBody}>
      <p id="scan-capture-review-status"><strong>{attempt.status === "success" ? "Result found" : attempt.status === "miss" ? "No result detected — try aiming again" : "Capture / recognition error"}</strong>
        {attempt.isDuplicate ? " · duplicate" : ""} · {Math.round(attempt.timings.totalMs)} ms</p>
      {frameUrl && <>
        {/* Already encoded processed frame, kept only until this review closes. No image optimizer/upload. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={styles.reviewFrame} src={frameUrl} alt="Captured processed frame" />
        <small>Processed capture after ROI / transforms. Temporary preview only.</small>
      </>}
      {attempt.error && <p className={styles.error}>{attempt.error}</p>}
      {attempt.outputs.map((output, i) => <div key={i} className={styles.result}>
        <strong>{output.engine}</strong>
        <pre aria-label={`${output.engine} review raw text`}>{output.rawText || "No text / barcode detected"}</pre>
        {output.detections.map((d, j) => <p key={j}>{d.symbology ?? "OCR line"}: {d.rawText}{d.confidence !== undefined ? ` · confidence ${d.confidence.toFixed(2)} (${d.confidenceScale})` : ""}</p>)}
        {extractCandidates(output.rawText).map((candidate, j) => <p className={styles.notice} key={`candidate-${j}`}>{candidate.field}: {candidate.candidate} · operator confirmation required</p>)}
      </div>)}
      <p className={styles.muted}>Check the label yourself. Raw results remain in session history; this review performs no operational action.</p>
    </div>
    <button type="button" className={styles.primary} onClick={onDismiss}>Back to camera / scan again</button>
  </dialog>;
}
