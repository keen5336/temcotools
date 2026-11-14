export function buildDriverPaperworkBookmarklet(origin: string) {
  const source = new URL("/api/driver-paperwork/payload", origin).href;
  // The injected panel's Create click opens the booklet. No manifest data goes
  // in the download URL, and loading the panel needs no popup permission.
  return `javascript:(()=>{
    const k='__temcoDriverPaperwork';if(window[k])return;
    const j={},s=document.createElement('script');window[k]=j;s.temcoDriverPaperwork=j;
    const done=m=>{if(window[k]!==j)return;clearTimeout(t);s.remove();delete window[k];if(m)alert(m)};
    const t=setTimeout(()=>done('Driver Paperwork took too long to load. Check your connection and try again.'),30000);
    s.src=${JSON.stringify(source)}+'?t='+Date.now();s.crossOrigin='anonymous';s.referrerPolicy='no-referrer';
    s.onerror=()=>done('Could not load Driver Paperwork from TemcoTools. Check your connection or this site’s script restrictions, then try again.');
    s.onload=()=>done(j.finished?'':'Driver Paperwork could not start. Try again or contact your TemcoTools administrator.');
    (document.head||document.documentElement).appendChild(s);
  })();`.replace(/\n\s*/g, "");
}
