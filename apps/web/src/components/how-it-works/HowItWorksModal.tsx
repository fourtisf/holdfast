"use client";

import { DEFEND_STEP_BPS, LAUNCH_FEE_LAMPORTS, ROUND_INTERVAL_SECONDS, TRIGGER_OPTIONS_BPS } from "@holdfast/core";
import type { ReactNode } from "react";
import { FeeSplitBar } from "@/components/coin/FeeSplitBar";
import { WeightRamp } from "@/components/coin/WeightRamp";
import { Badge } from "@/components/ui/Badge";
import { ButtonLink, Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { formatBpsAsPct } from "@/lib/format";
import { FloorDiagram } from "./FloorDiagram";

const LAUNCH_FEE_SOL = Number(LAUNCH_FEE_LAMPORTS) / 1e9;

interface Step {
  title: string;
  body: ReactNode;
  visual?: ReactNode;
}

const STEPS: Step[] = [
  {
    title: "Launch by sending SOL",
    body: (
      <>
        No wallet connection needed. Fill in the form and send <b className="text-fg">{LAUNCH_FEE_SOL} SOL</b> (plus an optional dev buy) to a one-time deposit
        address. Pick how far below the ATH the floor sits. The choice is <b className="text-fg">permanent</b>.
      </>
    ),
    visual: (
      <div className="flex flex-wrap gap-2">
        {TRIGGER_OPTIONS_BPS.map((bps) => (
          <Badge key={bps} tone={bps === 2500 ? "brand" : "muted"} className="px-2.5 py-1 text-xs">
            Floor −{formatBpsAsPct(bps)}
            {bps === 2500 ? " · default" : ""}
          </Badge>
        ))}
      </div>
    ),
  },
  {
    title: "Creator fees go to the coin's own vault",
    body: (
      <>
        Every trade pays a creator fee. On Holdfast the creator is an on-chain vault owned by the coin: <b className="text-fg">0% goes to the dev</b>, and the
        program has no withdraw function.
      </>
    ),
    visual: <FeeSplitBar />,
  },
  {
    title: "The floor follows the ATH",
    body: (
      <>
        <code className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-xs text-fg">floor = ATH × (1 − trigger)</code>. When the coin sets a new
        (time-weighted) all-time high, the floor moves up with it. It only rises, never falls.
      </>
    ),
    visual: <FloorDiagram className="h-24 w-full max-w-sm" />,
  },
  {
    title: "The vault defends the floor",
    body: (
      <>
        When the price is at or below the floor, the vault buys back with <b className="text-fg">{DEFEND_STEP_BPS / 100}% of the floor vault per step</b>, with
        cooldowns between steps. Bought-back tokens are <b className="text-fg">not burned</b>: they go to holders in the next payout.
      </>
    ),
  },
  {
    title: `Holders are paid every ${ROUND_INTERVAL_SECONDS / 60} minutes`,
    body: (
      <>
        Each round splits the holder pot (SOL + bought-back tokens) by <b className="text-fg">tokens × weight</b>. Weight starts at 0.1× when you buy and
        reaches 1.0× after 7 days. Selling part of your bag keeps the age of what is left; selling everything resets you. Dev-buy tokens and tokens received by
        transfer don&apos;t earn.
      </>
    ),
    visual: <WeightRamp className="h-20 max-w-xs" />,
  },
];

export function HowItWorksModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy="how-it-works-title"
      className="sm:max-w-2xl"
      title={
        <div>
          <div className="text-lg font-semibold">How Holdfast works</div>
          <div className="mt-0.5 text-sm font-normal text-muted">Coins that defend their own price and pay the holders who stay.</div>
        </div>
      }
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose}>
            Got it
          </Button>
          <ButtonLink href="/create" onClick={onClose}>
            Launch a coin
          </ButtonLink>
        </div>
      }
    >
      <ol className="px-5 py-5">
        {STEPS.map((step, i) => (
          <li key={step.title} className="relative flex gap-4 pb-6 last:pb-1">
            {i < STEPS.length - 1 ? <span className="absolute top-9 bottom-0 left-[15px] w-px bg-line" aria-hidden /> : null}
            <span className="relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full bg-brand/12 text-sm font-bold text-brand ring-1 ring-brand/30">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1 pt-1">
              <h3 className="font-semibold tracking-tight text-fg">{step.title}</h3>
              <p className="mt-1 text-sm leading-relaxed text-muted">{step.body}</p>
              {step.visual ? <div className="mt-3">{step.visual}</div> : null}
            </div>
          </li>
        ))}
      </ol>
    </Modal>
  );
}
