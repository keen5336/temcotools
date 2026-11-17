"use client";

import { useState, useSyncExternalStore } from "react";
import { connectTemcoBookmarklet } from "@/lib/api-relay/bookmarklet";

const subscribe = () => () => {};
const currentOrigin = () => window.location.origin;
const serverOrigin = () => "";

export default function RelayBookmarklet() {
  const origin = useSyncExternalStore(subscribe, currentOrigin, serverOrigin);
  const bookmarklet = origin ? connectTemcoBookmarklet(origin) : "";
  const [message, setMessage] = useState("");
  return <div className="space-y-3">
    <p className="text-sm">Install this bookmark once. Open a configured system, sign in, run <strong>Connect Temco</strong>, and confirm your account in the pairing window.</p>
    <div className="flex flex-wrap gap-3"><a className="btn btn-primary" draggable ref={element => { if (element) element.setAttribute("href", bookmarklet); }} onClick={event => { event.preventDefault(); setMessage("Drag Connect Temco to your bookmarks bar, or copy its bookmark URL."); }}>Connect Temco</a><button className="btn btn-outline" disabled={!bookmarklet} onClick={async () => { try { await navigator.clipboard.writeText(bookmarklet); setMessage("Copied. Paste this into a browser bookmark’s URL."); } catch { setMessage("Select and copy the bookmark URL below."); } }}>Copy bookmarklet</button></div>
    <details><summary className="cursor-pointer text-sm">Bookmark URL / phone setup</summary><p className="text-sm mt-2">On a phone or scanner, edit a bookmark and paste this into its URL. Run it from the bookmarks menu while viewing the external system.</p><textarea className="textarea textarea-bordered w-full mt-2 font-mono text-xs" rows={4} readOnly aria-label="Connect Temco bookmark URL" value={bookmarklet} /></details>
    {message && <p role="status" className="text-sm">{message}</p>}
  </div>;
}
