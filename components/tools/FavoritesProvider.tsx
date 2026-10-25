"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { changeFavorites, type FavoriteChange } from "@/lib/tool-favorites";
import { visibleFavoriteIds, type ToolRole } from "@/lib/tools";

type Preferences = { favoriteIds: string[]; role: ToolRole };
type Favorites = Preferences & { loaded: boolean; saving: boolean; error: string; reload: () => void; change: (change: FavoriteChange) => void };
const Context = createContext<Favorites | null>(null);
export function useFavorites() {
  const context = useContext(Context);
  if (!context) throw new Error("FavoritesProvider is required.");
  return context;
}

export default function FavoritesProvider({ userId, role, children }: { userId: string | null; role: ToolRole; children: React.ReactNode }) {
  const [preferences, setPreferences] = useState<Preferences>({ favoriteIds: [], role });
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const current = useRef(preferences);
  const busy = useRef(false);
  const alive = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const requestSerial = useRef(0);
  const accept = useCallback((data: Preferences) => {
    const next = { role: data.role, favoriteIds: visibleFavoriteIds(data.favoriteIds, data.role) };
    current.current = next; setPreferences(next);
  }, []);
  const load = useCallback(async () => {
    if (!userId || busy.current) return;
    const serial = ++requestSerial.current;
    try {
      const response = await fetch("/api/tool-favorites", { cache: "no-store", signal: controller.current?.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Favorites could not be loaded.");
      if (alive.current && !busy.current && serial === requestSerial.current) { accept(data); setError(""); setLoaded(true); }
    } catch (error) {
      if (alive.current && !controller.current?.signal.aborted && serial === requestSerial.current) setError(error instanceof Error ? error.message : "Favorites could not be loaded.");
    }
  }, [accept, userId]);
  useEffect(() => {
    alive.current = true; controller.current = new AbortController();
    void load();
    const focus = () => { void load(); };
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    window.addEventListener("focus", focus); document.addEventListener("visibilitychange", visible);
    return () => { alive.current = false; controller.current?.abort(); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", visible); };
  }, [load]);

  async function change(update: FavoriteChange) {
    if (!userId || !loaded || busy.current) return;
    const previous = current.current;
    const optimistic = changeFavorites(previous.favoriteIds, previous.role, update);
    requestSerial.current++;
    busy.current = true; setSaving(true); setError(""); accept({ ...previous, favoriteIds: optimistic });
    try {
      const response = await fetch("/api/tool-favorites", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(update), signal: controller.current?.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Favorites could not be saved.");
      if (alive.current) accept(data);
    } catch (error) {
      if (alive.current) { accept(previous); setError(error instanceof Error ? error.message : "Favorites could not be saved."); }
    } finally {
      busy.current = false;
      if (alive.current) setSaving(false);
    }
  }
  return <Context.Provider value={{ ...preferences, loaded, saving, error, reload: () => { void load(); }, change: (update) => { void change(update); } }}>{children}</Context.Provider>;
}
