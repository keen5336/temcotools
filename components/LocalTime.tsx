"use client";
import { useSyncExternalStore } from "react";
const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;
// The first client render must match server HTML even when their timezones or
// locales differ. Device formatting follows hydration; the exact instant stays
// available in the semantic datetime/title in every render.
export default function LocalTime({ value, timeZone }: { value: string; timeZone?: string }) {
  const hydrated = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  const date = new Date(value), iso = date.toISOString();
  return <time dateTime={iso} title={iso}>{hydrated ? date.toLocaleString(undefined, timeZone ? { timeZone } : undefined) : iso}</time>;
}
