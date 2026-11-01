"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Mount once in the authenticated shell. No timer/relay poll extends idle time:
// actual clicks, keyboard/scanner input or touch acknowledgements do.
export default function SessionActivity({ userId }: { userId: string | null }) {
  const router = useRouter();
  useEffect(() => {
    if (!userId) return;
    let lastSent = 0;
    let pending = false;
    const activity = () => {
      if (pending || Date.now() - lastSent < 60_000) return;
      pending = true;
      lastSent = Date.now();
      void fetch("/api/auth/activity", { method: "POST", cache: "no-store" })
        .then((response) => { if (response.status === 401 || response.status === 403) { router.push("/signin"); router.refresh(); } })
        .catch(() => { /* A network outage does not fabricate activity. */ })
        .finally(() => { pending = false; });
    };
    window.addEventListener("pointerdown", activity, true);
    window.addEventListener("keydown", activity, true);
    return () => { window.removeEventListener("pointerdown", activity, true); window.removeEventListener("keydown", activity, true); };
  }, [userId, router]);
  return null;
}
