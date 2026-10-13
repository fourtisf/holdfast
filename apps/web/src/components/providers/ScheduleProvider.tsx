"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { countdownAt, createRoundClock, type CountdownState, type RoundClock } from "@/lib/clock";

const RESYNC_MS = 60_000;
const ClockContext = createContext<RoundClock | null>(null);

/** Samples GET /schedule on mount, every minute and when the tab becomes visible again. */
export function ScheduleProvider({ children }: { children: ReactNode }) {
  const [clock, setClock] = useState<RoundClock | null>(null);

  useEffect(() => {
    let cancelled = false;
    const sync = async () => {
      const startedAt = Date.now();
      try {
        const schedule = await api.schedule();
        if (!cancelled) setClock(createRoundClock(schedule, startedAt, Date.now()));
      } catch {
        // keep the previous clock; next sync retries
      }
    };
    void sync();
    const id = setInterval(sync, RESYNC_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void sync();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return <ClockContext.Provider value={clock}>{children}</ClockContext.Provider>;
}

export function useRoundClock(): RoundClock | null {
  return useContext(ClockContext);
}

/** Ticking payout countdown on the server clock; null until the first sync. */
export function useRoundCountdown(tickMs = 250): CountdownState | null {
  const clock = useRoundClock();
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);
  return clock && now !== null ? countdownAt(clock, now) : null;
}
