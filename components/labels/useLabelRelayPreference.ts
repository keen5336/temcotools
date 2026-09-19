"use client";

import { useSyncExternalStore } from "react";

const key = "label-config.relay";
const eventName = "label-relay-preference";
const subscribe = (callback: () => void) => {
  window.addEventListener("storage", callback);
  window.addEventListener(eventName, callback);
  return () => { window.removeEventListener("storage", callback); window.removeEventListener(eventName, callback); };
};
const getSnapshot = () => localStorage.getItem(key) === "true";
const getServerSnapshot = () => false;

export function useLabelRelayPreference() {
  const relayEnabled = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const setRelayEnabled = (enabled: boolean) => {
    localStorage.setItem(key, String(enabled));
    window.dispatchEvent(new Event(eventName));
  };
  return { relayEnabled, setRelayEnabled };
}
