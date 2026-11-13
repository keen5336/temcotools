export function buildDriverPaperworkBookmarklet(origin: string) {
  const source = new URL("/api/driver-paperwork/payload", origin).href;
  // Open during the bookmark click: fetching the program can outlast the
  // browser's permission to open a window. No manifest data goes in this URL.
  return `javascript:(()=>{
    const k='__temcoDriverPaperwork';if(window[k])return;
    const w=window.open('','_blank');
    if(!w){alert('Allow pop-ups for this manifest page, then run Driver Paperwork again.');return}
    w.opener=null;w.document.title='Driver Paperwork';w.document.body.textContent='Loading Driver Paperwork…';
    const j={booklet:w},s=document.createElement('script');window[k]=j;s.temcoDriverPaperwork=j;
    const done=m=>{if(window[k]!==j)return;clearTimeout(t);s.remove();delete window[k];if(m){if(!w.closed)w.close();alert(m)}};
    const t=setTimeout(()=>done('Driver Paperwork took too long to load. Check your connection and try again.'),30000);
    s.src=${JSON.stringify(source)}+'?t='+Date.now();s.crossOrigin='anonymous';s.referrerPolicy='no-referrer';
    s.onerror=()=>done('Could not load Driver Paperwork from TemcoTools. Check your connection or this site’s script restrictions, then try again.');
    s.onload=()=>done(j.finished?'':'Driver Paperwork could not start. Try again or contact your TemcoTools administrator.');
    (document.head||document.documentElement).appendChild(s);
  })();`.replace(/\n\s*/g, "");
}
