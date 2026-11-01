"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

const Context = createContext<string | null>(null);
export function useUiContext() { return useContext(Context); }

// The snapshot belongs to this document. A later RSC refresh must never rebind
// old forms/async callbacks to a new cookie identity; a full reload clears them.
export default function UiContextBoundary({ context, children }: { context: string | null; children: ReactNode }) {
  const [initial] = useState(context), [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    const state = window.__temcoUiContextV1;
    const changed = () => setMessage(state?.message ?? "This page's sign-in changed. Reload before continuing.");
    window.addEventListener("temco-ui-context-blocked", changed);
    const timer = window.setTimeout(() => { if (!state || state.context !== initial || state.blocked) changed(); }, 0);
    return () => { window.clearTimeout(timer); window.removeEventListener("temco-ui-context-blocked", changed); };
  }, [initial]);
  if (message || context !== initial) return <main role="alert" className="mx-auto max-w-xl p-5 space-y-4"><h1 className="text-2xl font-bold">Sign-in changed</h1><p>{message ?? "The signed-in person or session changed. Reload before continuing."}</p><p>Pending actions were not replayed. Saved scanner observations and operation receipts remain available to their original person.</p><button className="btn btn-primary w-full" onClick={() => window.location.reload()}>Reload current sign-in</button></main>;
  return <Context.Provider value={initial}>{children}</Context.Provider>;
}
