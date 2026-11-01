export const PAYLOAD_PURPOSES = ["dmp_relay", "mars_label_helper", "route_planner_relay"] as const;
export const DEFAULT_DMP_PAYLOAD_ID = "dmp-relay";
export const MAX_PAYLOAD_BYTES = 128 * 1024;
export function sourceChanges(before: string, after: string) {
  const oldLines = before.split("\n"), newLines = after.split("\n");
  const changed: { line: number; before: string | null; after: string | null }[] = [];
  for (let index = 0; index < Math.max(oldLines.length, newLines.length); index++) {
    if (oldLines[index] !== newLines[index]) changed.push({ line: index + 1, before: oldLines[index] ?? null, after: newLines[index] ?? null });
  }
  return changed;
}
export function payloadPreviewDocument(source: string) {
  const safeSource = source.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src data:; form-action 'none'; base-uri 'none'; frame-src 'none'"><title>Synthetic payload preview</title></head><body><h1>Synthetic external page</h1><p>Order #</p><p>ORDER-DEMO-1</p><p>Submission #</p><p>DEMO-123</p><p>Serial #</p><p>SERIAL-DEMO-A</p><pre id="preview-status">Synthetic data only; no application session or relay authority. Fetch/socket connections and popups are blocked.</pre><script>window.addEventListener('error',event=>{document.getElementById('preview-status').textContent='Synthetic preview: '+event.message;});</script><script>const TEMCO_PAYLOAD=Object.freeze({payloadId:'synthetic-preview',versionId:'synthetic',protocolVersion:1,operationNames:[]});try{${safeSource}\n}catch(error){document.getElementById('preview-status').textContent='Synthetic preview: '+String(error&&error.message||error);}</script></body></html>`;
}
