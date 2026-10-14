"use client";

import { REPORT_REASONS, type ReportReason } from "@holdfast/core";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { ErrorNote } from "@/components/ui/States";
import { FlagIcon } from "@/components/ui/icons";
import { api, errorMessage } from "@/lib/api";

const LABELS: Record<ReportReason, string> = {
  scam: "Scam or rug",
  impersonation: "Impersonates a project or person",
  nsfw: "Sexual or shocking content",
  hate: "Hate or harassment",
  illegal: "Illegal content",
  other: "Something else",
};

/** "Report" link + modal. One report per visitor and coin; admins review them at /admin. */
export function ReportButton({ mint, ticker }: { mint: string; ticker: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ReportReason>("scam");
  const [details, setDetails] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "duplicate">("idle");
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setOpen(false);
    if (state !== "sending") {
      setState("idle");
      setError(null);
    }
  };

  async function submit() {
    setState("sending");
    setError(null);
    try {
      const res = await api.report(mint, { reason, details: details.trim() || undefined });
      setState(res.recorded ? "sent" : "duplicate");
    } catch (err) {
      setError(errorMessage(err));
      setState("idle");
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-faint transition-colors hover:bg-surface-3 hover:text-muted"
      >
        <FlagIcon size={13} />
        Report
      </button>
      <Modal
        open={open}
        onClose={close}
        title={`Report $${ticker}`}
        footer={
          state === "sent" || state === "duplicate" ? (
            <Button onClick={close} className="w-full">
              Close
            </Button>
          ) : (
            <Button onClick={submit} disabled={state === "sending"} className="w-full">
              {state === "sending" ? "Sending…" : "Send report"}
            </Button>
          )
        }
      >
        {state === "sent" ? (
          <p className="text-sm text-muted">Thanks. A moderator will look at this coin.</p>
        ) : state === "duplicate" ? (
          <p className="text-sm text-muted">You already reported this coin. A moderator will look at it.</p>
        ) : (
          <div className="flex flex-col gap-3">
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1 text-xs font-semibold text-muted">What is wrong?</legend>
              {REPORT_REASONS.map((r) => (
                <label key={r} className="flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-sm text-fg hover:bg-surface-2">
                  <input type="radio" name="reason" value={r} checked={reason === r} onChange={() => setReason(r)} className="accent-[var(--color-brand)]" />
                  {LABELS[r]}
                </label>
              ))}
            </fieldset>
            <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
              Details (optional)
              <textarea
                value={details}
                maxLength={500}
                onChange={(e) => setDetails(e.target.value)}
                rows={3}
                className="rounded-control border border-line bg-surface-2 px-3 py-2 text-sm font-normal text-fg outline-none focus:border-line-strong"
                placeholder="Links or context that help a moderator"
              />
            </label>
            <p className="text-xs text-faint">Hiding a coin removes it from Moatpad&apos;s lists. It keeps trading on pump.fun, and its holders keep being paid.</p>
            {error ? <ErrorNote>{error}</ErrorNote> : null}
          </div>
        )}
      </Modal>
    </>
  );
}

/** Banner on a coin hidden by moderators. */
export function HiddenNotice({ reason }: { reason: string | null }) {
  return (
    <div role="status" className="rounded-card border border-sell/30 bg-sell/10 px-4 py-3 text-sm text-fg">
      <span className="font-semibold">Hidden by Moatpad moderators.</span>{" "}
      <span className="text-muted">
        {reason ? `Reason: ${reason}. ` : ""}Its image, description and links are not shown. The coin keeps trading on pump.fun and its vault keeps
        working for holders.
      </span>
    </div>
  );
}
