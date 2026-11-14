import { PAPERWORK_ASSETS } from "@/scripts/driver-paperwork/assets.mjs";
import { SAMPLE_MANIFEST } from "./sample";
import type { PaperworkTemplates } from "./templates";

export function buildTemplatePreview(template: PaperworkTemplates, program: string, nonce: string) {
  const json = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'"></head><body><p>Preparing sample booklet…</p><script>
  (async () => {
    const report = error => parent.postMessage({type:'driver-paperwork-preview',nonce:${json(nonce)},error}, '*');
    try {
      const factory = new Function(${json(program + "\nreturn createDriverPaperworkRuntime;")})();
      const runtime = factory(${json(template)}, ${json(PAPERWORK_ASSETS)});
      const html = runtime.buildBooklet(${json(SAMPLE_MANIFEST)}, ['SH31']);
      const doc = new DOMParser().parseFromString(html, 'text/html');
      // Preserve this document's CSP while adopting the printable styles/body.
      for (const style of doc.querySelectorAll('style')) document.head.appendChild(style.cloneNode(true));
      document.body.replaceChildren(...doc.body.childNodes);
      document.querySelector('.toolbar')?.remove();
      await Promise.all([...document.images].map(image => image.decode()));
      await document.fonts.ready;
      runtime.paginate(window);
      report(null);
    } catch(error) { document.body.textContent = error?.message || 'Preview failed.'; report(error?.message || 'Preview failed.'); }
  })();
  </script></body></html>`;
}
