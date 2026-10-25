"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { toolSections, type Tool } from "@/lib/tools";
import { useFavorites } from "./FavoritesProvider";
import Star from "./Star";

export default function MobileToolDrawer() {
  const { role, favoriteIds, loaded } = useFavorites();
  const { favorites, remaining } = toolSections(role, favoriteIds);
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  function close() { dialog.current?.close(); setOpen(false); }
  useEffect(() => { dialog.current?.close(); }, [pathname]);
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 768px)");
    const resize = () => { if (desktop.matches) { dialog.current?.close(); setOpen(false); } };
    desktop.addEventListener("change", resize);
    return () => desktop.removeEventListener("change", resize);
  }, []);
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [open]);
  function links(tools: Tool[]) {
    return <ul className="menu w-full p-0 gap-1">{tools.map((tool) => {
      const active = pathname === tool.href || pathname.startsWith(`${tool.href}/`);
      return <li key={tool.id}><Link href={tool.href} onClick={close} aria-current={active ? "page" : undefined} className={active ? "menu-active" : ""}>{tool.name}</Link></li>;
    })}</ul>;
  }
  return <>
    <button type="button" className="btn btn-ghost btn-square btn-sm shrink-0 md:hidden" aria-label="Open tools menu" aria-expanded={open} aria-controls="mobile-tools-drawer" onClick={() => { dialog.current?.showModal(); setOpen(true); }}><svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 6h16M4 12h16M4 18h16" /></svg></button>
    <dialog ref={dialog} id="mobile-tools-drawer" aria-labelledby="mobile-tools-heading" className="fixed inset-y-0 left-0 right-auto m-0 h-dvh max-h-none w-[min(20rem,calc(100vw-2rem))] max-w-none border-r border-base-300 bg-base-100 p-0 text-base-content shadow-2xl backdrop:bg-black/40" onClose={() => setOpen(false)}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = event.currentTarget.querySelectorAll<HTMLElement>('a[href], button:not([disabled])');
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}
      onClick={(event) => { if (event.target !== event.currentTarget) return; const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close(); }}>
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b border-base-300 px-4 py-3"><h2 id="mobile-tools-heading" className="font-semibold text-lg">Tools</h2><button type="button" className="btn btn-ghost btn-square btn-sm" aria-label="Close tools menu" onClick={close}><span aria-hidden="true" className="text-2xl leading-none">×</span></button></div>
        <nav aria-label="Mobile tools" className="flex-1 overflow-y-auto p-4 space-y-5">
          <Link href="/" onClick={close} className="btn btn-ghost w-full justify-start" aria-current={pathname === "/" ? "page" : undefined}>Home</Link>
          {favorites.length > 0 && <section aria-labelledby="mobile-favorites-heading"><h3 id="mobile-favorites-heading" className="text-xs font-semibold uppercase tracking-wide text-base-content/60 flex items-center gap-2 mb-2"><Star filled className="h-4 w-4 text-warning" />Favorites</h3>{links(favorites)}</section>}
          <section aria-labelledby="mobile-operations-heading"><h3 id="mobile-operations-heading" className="text-xs font-semibold uppercase tracking-wide text-base-content/60 mb-2">Operations Tools</h3>{!loaded && <p className="text-xs text-base-content/60 mb-2">Loading favorites…</p>}{links(remaining)}</section>
        </nav>
        <div className="border-t border-base-300 p-3"><Link href="/#favorites" onClick={close} className="btn btn-ghost btn-sm w-full">Manage favorites on Home</Link></div>
      </div>
    </dialog>
  </>;
}
