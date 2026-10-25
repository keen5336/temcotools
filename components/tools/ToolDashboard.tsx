"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { toolSections, type Tool } from "@/lib/tools";
import { useFavorites } from "./FavoritesProvider";
import Star from "./Star";

export default function ToolDashboard() {
  const { role, favoriteIds, loaded, saving, error, change, reload } = useFavorites();
  const { favorites, remaining } = toolSections(role, favoriteIds);
  const [editing, setEditing] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const focusTarget = useRef<string | null>(null);
  useEffect(() => {
    if (!focusTarget.current) return;
    document.querySelector<HTMLButtonElement>(`[data-favorite-button="${focusTarget.current}"]`)?.focus({ preventScroll: true });
    focusTarget.current = null;
  }, [favoriteIds]);

  function move(id: string, destination: number) {
    const order = [...favoriteIds];
    const from = order.indexOf(id);
    if (from < 0 || destination < 0 || destination >= order.length || destination === from) return;
    order.splice(from, 1); order.splice(destination, 0, id);
    change({ action: "reorder", order });
  }
  function card(tool: Tool, favorite: boolean, index = 0) {
    return <article key={tool.id} data-tool-id={tool.id} className={`relative rounded-lg border bg-base-100 transition ${dropTarget === tool.id ? "border-primary ring-2 ring-primary/30" : "border-base-200 hover:border-primary hover:shadow-sm"}`} draggable={favorite && editing && !saving}
      onDragStart={(event) => { if (!editing || !favorite) return; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", tool.id); setDragging(tool.id); }}
      onDragOver={(event) => { if (favorite && editing && dragging && dragging !== tool.id) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropTarget(tool.id); } }}
      onDragLeave={() => setDropTarget(null)} onDragEnd={() => { setDragging(null); setDropTarget(null); }}
      onDrop={(event) => { event.preventDefault(); if (dragging && editing && favorite && !saving) move(dragging, index); setDragging(null); setDropTarget(null); }}>
      <Link href={tool.href} draggable={false} className="block rounded-lg p-5 pr-14 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
        <h3 className="font-semibold text-base-content mb-1">{tool.name}</h3><p className="text-sm text-base-content/70">{tool.description}</p>
      </Link>
      <button type="button" data-favorite-button={tool.id} className={`btn btn-ghost btn-square btn-sm absolute top-3 right-3 ${favorite ? "text-warning" : "text-base-content/50 hover:text-warning"}`} disabled={!loaded} aria-disabled={saving || !loaded} aria-label={`${favorite ? "Remove" : "Add"} ${tool.name} ${favorite ? "from" : "to"} favorites`} aria-pressed={favorite} title={favorite ? "Remove from favorites" : "Add to favorites"}
        onClick={() => { if (saving) return; focusTarget.current = tool.id; change({ action: "set", toolId: tool.id, favorite: !favorite }); }}><Star filled={favorite} /></button>
      {favorite && editing && <div className="flex items-center justify-between gap-2 border-t border-base-200 px-3 py-2">
        <span className="text-xs text-base-content/60"><span aria-hidden="true">⠿ </span>Drag to reorder</span>
        <div className="flex gap-1"><button type="button" className="btn btn-ghost btn-square btn-sm" disabled={saving || index === 0} aria-label={`Move ${tool.name} earlier`} onClick={() => move(tool.id, index - 1)}><span aria-hidden="true">←</span></button><button type="button" className="btn btn-ghost btn-square btn-sm" disabled={saving || index === favorites.length - 1} aria-label={`Move ${tool.name} later`} onClick={() => move(tool.id, index + 1)}><span aria-hidden="true">→</span></button></div>
      </div>}
    </article>;
  }

  return <div className="space-y-10">
    <h1 className="sr-only">Your tools</h1>
    <section id="favorites" aria-labelledby="favorites-heading" className="scroll-mt-4">
      <div className="flex flex-wrap justify-between items-center gap-3 mb-2"><h2 id="favorites-heading" className="text-2xl font-semibold flex items-center gap-2"><Star filled className="h-6 w-6 text-warning" />Favorites</h2>
        {(favorites.length > 1 || editing) && <button type="button" className="btn btn-sm btn-ghost" disabled={saving} aria-pressed={editing} onClick={() => setEditing((value) => !value)}>{editing ? "Done" : "Reorder favorites"}</button>}
      </div>
      <p className="text-base-content/70 text-sm mb-5">Star the tools you use most to keep them here.</p>
      {error && <div className="alert alert-error mb-4" role="alert"><span>{error}</span><button type="button" className="btn btn-sm" onClick={reload}>Try again</button></div>}
      {!loaded && !error ? <div className="rounded-lg border border-dashed border-base-300 p-6 text-base-content/60" role="status">Loading your favorites…</div> : favorites.length ? <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">{favorites.map((tool, index) => card(tool, true, index))}</div> : <div className="rounded-lg border border-dashed border-base-300 p-6 text-base-content/60">No favorites yet. Choose a star on any tool below to get started.</div>}
      <p className="text-xs text-base-content/60 mt-3" role="status" aria-live="polite">{saving ? "Saving favorites…" : error ? "Favorites are not up to date." : loaded ? "Favorites are saved to your account." : ""}</p>
    </section>
    <section aria-labelledby="operations-heading"><h2 id="operations-heading" className="text-2xl font-semibold mb-2">Operations Tools</h2><p className="text-base-content/70 mb-5">{remaining.length ? "Select a tool to get started." : "All your tools are in Favorites."}</p><div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">{remaining.map((tool) => card(tool, false))}</div></section>
  </div>;
}
