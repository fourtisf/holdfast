"use client";

import { useCallback, useSyncExternalStore } from "react";

/** Starred coins, kept in this browser (localStorage) and synced across tabs. */
const KEY = "holdfast:watchlist";
const EVENT = "holdfast:watchlist";
const MAX = 100;
const EMPTY: readonly string[] = [];

let cache: { raw: string | null; list: readonly string[] } = { raw: null, list: EMPTY };

function read(): readonly string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === cache.raw) return cache.list;
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string").slice(0, MAX) : [];
    cache = { raw, list };
    return list;
  } catch {
    return EMPTY;
  }
}

function write(list: readonly string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    // storage unavailable
  }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(cb: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) cb();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(EVENT, cb);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(EVENT, cb);
  };
}

/** Pure toggle (newest first, capped). */
export function toggleInList(list: readonly string[], mint: string): string[] {
  return list.includes(mint) ? list.filter((m) => m !== mint) : [mint, ...list].slice(0, MAX);
}

export function useWatchlist() {
  const list = useSyncExternalStore(subscribe, read, () => EMPTY);
  const toggle = useCallback((mint: string) => write(toggleInList(read(), mint)), []);
  const has = useCallback((mint: string) => list.includes(mint), [list]);
  return { list, toggle, has };
}
