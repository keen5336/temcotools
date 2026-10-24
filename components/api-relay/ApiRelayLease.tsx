"use client";

import { useEffect } from "react";

// Pairings expire if the user's authenticated Temco browser goes away. This
// stays mounted across tools, just like the label-relay provider.
export default function ApiRelayLease({ userId }: { userId: string | null }) {
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    let busy = false;
    const renew = async () => {
      if (busy) return;
      busy = true;
      try { await fetch("/api/api-relay/lease", { method: "POST", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) }); }
      catch { /* Lease expiry disconnects the relay if Temco cannot authenticate. */ }
      finally { busy = false; }
    };
    void renew();
    const timer = setInterval(() => { void renew(); }, 10000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [userId]);
  return null;
}
