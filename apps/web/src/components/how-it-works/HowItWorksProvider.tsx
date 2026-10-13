"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { HowItWorksModal } from "./HowItWorksModal";

interface HowItWorksApi {
  open: () => void;
  close: () => void;
}

const Ctx = createContext<HowItWorksApi>({ open: () => {}, close: () => {} });

export function HowItWorksProvider({ children }: { children: ReactNode }) {
  const [isOpen, setOpen] = useState(false);
  const open = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  const value = useMemo(() => ({ open, close }), [open, close]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <HowItWorksModal open={isOpen} onClose={close} />
    </Ctx.Provider>
  );
}

export function useHowItWorks(): HowItWorksApi {
  return useContext(Ctx);
}
