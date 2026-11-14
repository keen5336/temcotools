"use client";

import Image from "next/image";
import dynamic from "next/dynamic";
import { useState, useSyncExternalStore } from "react";
import { buildDriverPaperworkBookmarklet } from "@/lib/driver-paperwork/bookmarklet";

const subscribe = () => () => {};
const TemplateEditor = dynamic(() => import("./TemplateEditor"));

export default function DriverPaperworkClient({ canEdit = false }: { canEdit?: boolean }) {
  const origin = useSyncExternalStore(subscribe, () => window.location.origin, () => "");
  const bookmarklet = origin ? buildDriverPaperworkBookmarklet(origin) : "";
  const [notice, setNotice] = useState("");

  async function copy() {
    try {
      await navigator.clipboard.writeText(bookmarklet);
      setNotice("Bookmarklet copied. Paste it into a bookmark’s URL field.");
    } catch {
      setNotice("Open Bookmarklet text below, then select and copy the complete URL.");
    }
  }

  return <div className="space-y-6">
    <header className="space-y-3">
      <div className="inline-block rounded-lg bg-white p-3">
        <Image src="/driver-paperwork/temco-logo.jpg" alt="TEMCO Logistics" width={1440} height={360} unoptimized priority className="w-60 max-w-full h-auto" />
      </div>
      <h1 className="text-2xl font-semibold">Driver Paperwork</h1>
      <p className="text-base-content/70">Prepare a driver booklet from a Home Depot route manifest. Install the bookmark once to get the latest version every time you use it.</p>
    </header>

    <section className="rounded-box border border-base-300 bg-base-100 p-5 space-y-4" aria-labelledby="install-heading">
      <h2 id="install-heading" className="text-lg font-semibold">Install the bookmarklet</h2>
      <p>Show your browser’s bookmarks bar, then drag this button onto it.</p>
      <div className="flex flex-wrap items-center gap-3">
        <a className="btn btn-primary" draggable={Boolean(bookmarklet)} aria-disabled={!bookmarklet}
          ref={(element) => { if (element && bookmarklet) element.setAttribute("href", bookmarklet); }}
          onClick={(event) => { event.preventDefault(); setNotice("Drag TEMCO Driver Paperwork to your bookmarks bar, then use it on a route manifest page."); }}>
          TEMCO Driver Paperwork
        </a>
        <button type="button" className="btn btn-outline" disabled={!bookmarklet} onClick={() => { void copy(); }}>Copy bookmarklet</button>
      </div>
      <p className="text-sm text-base-content/70">Already have the older Driver Paperwork bookmark? Replace it with this one once. Future updates will load from TemcoTools automatically.</p>
      <details>
        <summary className="cursor-pointer">Bookmarklet text</summary>
        <p className="mt-3 text-sm">If dragging is unavailable, create a bookmark and replace its URL with the complete text below.</p>
        <textarea className="textarea textarea-bordered w-full mt-2 font-mono text-xs" aria-label="Bookmarklet URL" readOnly rows={6} value={bookmarklet} />
      </details>
      {notice && <p role="status" aria-live="polite">{notice}</p>}
    </section>

    <section className="rounded-box border border-base-300 bg-base-100 p-5 space-y-3" aria-labelledby="use-heading">
      <h2 id="use-heading" className="text-lg font-semibold">Create driver paperwork</h2>
      <ol className="list-decimal pl-5 space-y-2">
        <li>Open the Home Depot route manifest page with selectable text.</li>
        <li>Click your saved <strong>TEMCO Driver Paperwork</strong> bookmark. In the panel, choose a route and driver, or <strong>All routes</strong>, then choose <strong>Create booklet</strong>.</li>
        <li>Review the booklet. You can type into Dock/Wave, Special Attention, and the signature line.</li>
        <li>Choose <strong>Print / Save PDF</strong>. Use Letter paper at 100% scale and turn off browser headers and footers. Print in color for the yellow survey panel on customer stop sheets.</li>
      </ol>
      <p className="text-sm text-base-content/70">Allow pop-ups for the manifest page. The bookmark needs an internet connection to load and cannot read a browser PDF viewer or an image-only manifest.</p>
      <p className="text-sm text-base-content/70">Your manifest stays in your browser. Route and customer details are not uploaded to TemcoTools.</p>
    </section>
    {canEdit && <TemplateEditor />}
  </div>;
}
