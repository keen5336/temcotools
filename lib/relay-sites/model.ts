import { exactSiteOrigin } from "./types";

export function connectTemcoBookmarklet(appOrigin: string) {
  const origin = exactSiteOrigin(appOrigin);
  return `javascript:(()=>{if(window.__temcoApiRelay?.busy?.()){alert('Temco work is still running. Wait for its original result.');return;}var u=new URL(${JSON.stringify(`${origin}/api/connect-temco/loader`)});u.searchParams.set('origin',location.origin);u.searchParams.set('pathname',location.pathname);var s=document.createElement('script');s.referrerPolicy='no-referrer';s.src=u.href;s.onerror=()=>alert('Connect Temco could not load. Check the connection and this page policy; no work was retried.');(document.head||document.documentElement).appendChild(s)})();`;
}
