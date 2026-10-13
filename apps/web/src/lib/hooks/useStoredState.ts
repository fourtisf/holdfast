"use client";

import { useCallback, useEffect, useState } from "react";

/** useState persisted to localStorage (read after mount, so server and first client render agree). */
export function useStoredState<T>(key: string, initial: T, isValid: (v: unknown) => v is T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return;
      const parsed: unknown = JSON.parse(raw);
      if (isValid(parsed)) setValue(parsed);
    } catch {
      // storage unavailable
    }
  }, [key, isValid]);
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        // storage unavailable
      }
    },
    [key],
  );
  return [value, set];
}
