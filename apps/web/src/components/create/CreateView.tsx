"use client";

import { DEFAULT_TRIGGER_BPS, type LaunchResponse } from "@holdfast/core";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ErrorNote } from "@/components/ui/States";
import { cn } from "@/components/ui/cn";
import { GlobeIcon, InfoIcon, TelegramIcon, XLogoIcon } from "@/components/ui/icons";
import { api, errorMessage } from "@/lib/api";
import { formatSolAmount } from "@/lib/format";
import {
  DESCRIPTION_MAX,
  LAUNCH_FEE_SOL,
  NAME_MAX,
  TICKER_MAX,
  normalizeTicker,
  parseDevBuy,
  requiredDepositSol,
  toLaunchRequest,
  validateLaunch,
  type LaunchForm,
} from "@/lib/launch";
import { DepositModal } from "./DepositModal";
import { ImageDrop } from "./ImageDrop";
import { LaunchPreview } from "./LaunchPreview";
import { TriggerPicker } from "./TriggerPicker";

const EMPTY: LaunchForm = {
  name: "",
  ticker: "",
  description: "",
  imageUrl: null,
  x: "",
  telegram: "",
  website: "",
  triggerBps: DEFAULT_TRIGGER_BPS,
  devBuy: "",
};
const DEV_PRESETS = [0.5, 1, 2];

const inputClass =
  "h-11 w-full rounded-control border bg-surface-2 px-3 text-sm text-fg placeholder:text-faint transition-colors focus:border-faint focus:outline-none";

function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
  aside,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  htmlFor?: string;
  aside?: ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <label htmlFor={htmlFor} className="text-sm font-semibold text-fg">
          {label}
        </label>
        {aside}
      </div>
      {children}
      {error ? <p className="mt-1 text-xs text-sell">{error}</p> : hint ? <p className="mt-1 text-xs text-faint">{hint}</p> : null}
    </div>
  );
}

function Section({ step, title, children, subtitle }: { step: number; title: string; subtitle?: string; children: ReactNode }) {
  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-4 flex items-start gap-3">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-3 text-xs font-bold text-muted">{step}</span>
        <div>
          <h2 className="font-semibold tracking-tight text-fg">{title}</h2>
          {subtitle ? <p className="text-xs text-muted">{subtitle}</p> : null}
        </div>
      </div>
      <div className="space-y-4">{children}</div>
    </Card>
  );
}

export function CreateView() {
  const [form, setForm] = useState<LaunchForm>(EMPTY);
  const [preview, setPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [launch, setLaunch] = useState<{ res: LaunchResponse; ticker: string; devBuySol: number } | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const errors = validateLaunch(form);
  const shown = touched ? errors : {};
  const devBuySol = parseDevBuy(form.devBuy) ?? 0;
  const total = requiredDepositSol(devBuySol);
  const set = <K extends keyof LaunchForm>(key: K, value: LaunchForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const border = (key: keyof LaunchForm) => (shown[key] ? "border-sell/60" : "border-line-strong");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(errors).length > 0 || uploading) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const req = toLaunchRequest(form);
      const res = await api.launch(req);
      setLaunch({ res, ticker: req.ticker, devBuySol: req.devBuySol ?? 0 });
      setModalOpen(true);
    } catch (err) {
      setSubmitError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const restart = () => {
    setModalOpen(false);
    setLaunch(null);
  };

  return (
    <div className="mx-auto max-w-[1080px]">
      <div className="mb-5">
        <h1 className="text-2xl font-semibold tracking-tight text-fg sm:text-[28px]">Launch a coin</h1>
        <p className="mt-1 text-sm text-muted">
          No wallet connection. Send {LAUNCH_FEE_SOL} SOL to a one-time address and your coin goes live on pump.fun with its own floor vault.
        </p>
      </div>

      {launch && !modalOpen ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-card border border-brand/30 bg-brand/8 px-4 py-3 text-sm">
          <span className="text-fg">
            Launch of <b>${launch.ticker}</b> is waiting for its deposit.
          </span>
          <Button size="sm" onClick={() => setModalOpen(true)}>
            Show deposit details
          </Button>
        </div>
      ) : null}

      <form onSubmit={submit} noValidate className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <div className="space-y-4">
          <Section step={1} title="Coin details">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
              <Field
                label="Name"
                htmlFor="name"
                error={shown.name}
                aside={
                  <span className="text-[11px] text-faint tabular">
                    {form.name.length}/{NAME_MAX}
                  </span>
                }
              >
                <input
                  id="name"
                  value={form.name}
                  maxLength={NAME_MAX}
                  onChange={(e) => set("name", e.target.value)}
                  placeholder="Kelp Lord"
                  className={cn(inputClass, border("name"))}
                  autoComplete="off"
                />
              </Field>
              <Field
                label="Ticker"
                htmlFor="ticker"
                error={shown.ticker}
                aside={
                  <span className="text-[11px] text-faint tabular">
                    {form.ticker.length}/{TICKER_MAX}
                  </span>
                }
              >
                <div className="relative">
                  <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-faint">$</span>
                  <input
                    id="ticker"
                    value={form.ticker}
                    onChange={(e) => set("ticker", normalizeTicker(e.target.value))}
                    placeholder="KELP"
                    className={cn(inputClass, "pl-6 uppercase", border("ticker"))}
                    autoComplete="off"
                  />
                </div>
              </Field>
            </div>
            <Field
              label="Description"
              htmlFor="description"
              error={shown.description}
              aside={
                <span className="text-[11px] text-faint tabular">
                  {form.description.length}/{DESCRIPTION_MAX}
                </span>
              }
            >
              <textarea
                id="description"
                value={form.description}
                maxLength={DESCRIPTION_MAX}
                onChange={(e) => set("description", e.target.value)}
                rows={3}
                placeholder="What is this coin about?"
                className={cn(inputClass, "h-auto resize-none py-2.5", border("description"))}
              />
            </Field>
            <Field label="Image">
              <ImageDrop
                onUploaded={(url, localPreview) => {
                  set("imageUrl", url);
                  setPreview(localPreview);
                }}
                onUploadingChange={setUploading}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-3">
              {(
                [
                  ["x", "X", "@handle or link", <XLogoIcon key="x" size={13} />],
                  ["telegram", "Telegram", "t.me/group", <TelegramIcon key="t" size={14} />],
                  ["website", "Website", "yourcoin.fun", <GlobeIcon key="w" size={14} />],
                ] as const
              ).map(([key, label, placeholder, icon]) => (
                <Field key={key} label={label} htmlFor={key} error={shown[key]}>
                  <div className="relative">
                    <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint">{icon}</span>
                    <input
                      id={key}
                      value={form[key]}
                      onChange={(e) => set(key, e.target.value)}
                      placeholder={placeholder}
                      className={cn(inputClass, "pl-9", border(key))}
                      autoComplete="off"
                    />
                  </div>
                </Field>
              ))}
            </div>
          </Section>

          <Section step={2} title="Choose the floor" subtitle="How far below the ATH the vault starts buying back">
            <TriggerPicker value={form.triggerBps} onChange={(v) => set("triggerBps", v)} />
          </Section>

          <Section step={3} title="Dev buy (optional)" subtitle="Buy your own coin in the same transaction as the launch">
            <Field
              label="Amount"
              htmlFor="devBuy"
              error={shown.devBuy}
              hint={
                <span className="flex items-start gap-1.5">
                  <InfoIcon size={13} className="mt-px shrink-0" />
                  Dev-buy tokens go to the address you deposit from and do not earn holder payouts.
                </span>
              }
            >
              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="relative flex-1">
                  <input
                    id="devBuy"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="any"
                    value={form.devBuy}
                    onChange={(e) => set("devBuy", e.target.value)}
                    placeholder="0"
                    className={cn(inputClass, "pr-12", border("devBuy"))}
                  />
                  <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm font-semibold text-muted">SOL</span>
                </div>
                <div className="grid grid-cols-4 gap-1.5 sm:flex">
                  {[0, ...DEV_PRESETS].map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => set("devBuy", v === 0 ? "" : String(v))}
                      className={cn(
                        "h-11 rounded-control px-3 text-xs font-semibold ring-1 ring-line sm:min-w-14",
                        devBuySol === v ? "bg-fg text-bg" : "bg-surface-2 text-muted hover:text-fg",
                      )}
                    >
                      {v === 0 ? "None" : `${v}`}
                    </button>
                  ))}
                </div>
              </div>
            </Field>
          </Section>
        </div>

        <div className="space-y-4 lg:sticky lg:top-[calc(var(--nav-height)+20px)]">
          <LaunchPreview form={form} preview={preview} />
          <Card className="p-4">
            <div className="text-[11px] font-semibold tracking-wider text-muted uppercase">You send</div>
            <dl className="mt-2 space-y-1.5 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted">Launch cost (network + accounts)</dt>
                <dd className="text-fg tabular">{LAUNCH_FEE_SOL} SOL</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">Dev buy</dt>
                <dd className="text-fg tabular">{formatSolAmount(devBuySol)} SOL</dd>
              </div>
              <div className="flex justify-between border-t border-line pt-2 font-semibold">
                <dt className="text-fg">Total</dt>
                <dd className="text-brand tabular">{formatSolAmount(total)} SOL</dd>
              </div>
            </dl>
            <p className="mt-2 text-xs text-faint">Anything above the total is refunded to the sender. Creator fees go to the coin&apos;s vault: 0% to you.</p>
            {submitError ? <ErrorNote className="mt-3">{submitError}</ErrorNote> : null}
            {touched && Object.keys(errors).length > 0 ? <p className="mt-3 text-xs text-sell">Fix the highlighted fields to continue.</p> : null}
            <Button type="submit" size="lg" className="mt-3 w-full" disabled={submitting || uploading}>
              {submitting ? "Creating deposit address…" : uploading ? "Waiting for image upload…" : `Launch · send ${formatSolAmount(total)} SOL`}
            </Button>
          </Card>
        </div>
      </form>

      {launch && modalOpen ? (
        <DepositModal launch={launch.res} ticker={launch.ticker} devBuySol={launch.devBuySol} onClose={() => setModalOpen(false)} onRestart={restart} />
      ) : null}
    </div>
  );
}
