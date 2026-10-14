"use client";

import { verifyRoundSnapshot, type RoundSnapshot } from "@holdfast/core";
import { useConnection } from "@solana/wallet-adapter-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { cn } from "@/components/ui/cn";
import { CheckShieldIcon, CloseIcon, ExternalIcon, InfoIcon } from "@/components/ui/icons";
import { API_URL, SOLANA_CLUSTER, USE_MOCKS } from "@/lib/config";
import { explorerTxUrl } from "@/lib/explorer";
import { formatRelativeTime, formatSol, formatTokens, shortAddress } from "@/lib/format";
import { errorMessage } from "@/lib/api";
import { useCoin, useRound } from "@/lib/hooks/queries";
import { useNow } from "@/lib/hooks/useNow";
import { fetchCommittedRoot } from "@/lib/solana";

type CheckState = "ok" | "fail" | "pending" | "unavailable";

function Check({ state, title, detail }: { state: CheckState; title: string; detail: string }) {
  const tone = state === "ok" ? "text-brand" : state === "fail" ? "text-sell" : "text-faint";
  return (
    <div className="flex gap-3 rounded-card border border-line bg-surface p-3.5">
      <span className={cn("mt-0.5 shrink-0", tone)}>
        {state === "ok" ? <CheckShieldIcon size={18} /> : state === "fail" ? <CloseIcon size={18} /> : <InfoIcon size={18} />}
      </span>
      <div className="min-w-0">
        <div className="text-sm font-semibold text-fg">{title}</div>
        <div className="mt-0.5 text-xs break-words text-muted">{detail}</div>
      </div>
    </div>
  );
}

function download(snapshot: RoundSnapshot) {
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `moatpad-${snapshot.mint}-round-${snapshot.roundId}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Verifies a payout round in the browser: recomputes every payout from the published inputs with
 * @holdfast/core, compares the merkle root with the published one, and reads the root the keeper
 * committed on-chain in `open_round` from the RPC. No trust in the Holdfast API needed.
 */
export function RoundVerifyView({ mint, roundId }: { mint: string; roundId: number }) {
  const { data: snapshot, error, isLoading } = useRound(mint, roundId);
  const { data: coin } = useCoin(mint);
  const { connection } = useConnection();
  const now = useNow(30_000);
  const [chain, setChain] = useState<{ state: CheckState; root: string | null; note: string }>({ state: "pending", root: null, note: "Reading the open_round transaction…" });

  const recomputed = useMemo(() => (snapshot ? verifyRoundSnapshot(snapshot) : null), [snapshot]);

  useEffect(() => {
    if (!snapshot) return;
    if (USE_MOCKS) {
      setChain({ state: "unavailable", root: null, note: "Mock mode: there is no chain to read." });
      return;
    }
    if (!snapshot.openSig) {
      setChain({ state: "unavailable", root: null, note: "This round has not been opened on-chain yet." });
      return;
    }
    let cancelled = false;
    fetchCommittedRoot(connection, snapshot.openSig, mint, roundId)
      .then(({ root, failed }) => {
        if (cancelled) return;
        if (failed) setChain({ state: "fail", root, note: "The open_round transaction failed on-chain." });
        else if (!root) setChain({ state: "unavailable", root: null, note: "The RPC does not have this transaction (pruned history?). Try an archival RPC." });
        else if (root === snapshot.snapshotHash) setChain({ state: "ok", root, note: `On-chain root ${root.slice(0, 16)}… matches.` });
        else setChain({ state: "fail", root, note: `On-chain root ${root} differs from the published ${snapshot.snapshotHash}.` });
      })
      .catch((err) => !cancelled && setChain({ state: "unavailable", root: null, note: `RPC error: ${errorMessage(err)}` }));
    return () => {
      cancelled = true;
    };
  }, [snapshot, connection, mint, roundId]);

  if (error && !snapshot)
    return (
      <Card>
        <EmptyState title="Round not found" body={errorMessage(error)} action={<Link href={`/coin/${mint}`}>Back to the coin</Link>} />
      </Card>
    );
  if (isLoading || !snapshot || !recomputed) return <div className="h-64 animate-pulse rounded-card bg-surface" />;

  const allOk = recomputed.ok && chain.state === "ok";
  const ticker = coin?.ticker ?? shortAddress(mint);
  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        <Link href={`/coin/${mint}`} className="text-xs font-semibold text-muted hover:text-fg">
          ← ${ticker}
        </Link>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold tracking-tight text-fg">Payout round #{snapshot.roundId}</h1>
          <span className="text-xs text-faint">{formatRelativeTime(snapshot.ts, now)}</span>
          <span className={cn("ml-auto text-sm font-semibold", allOk ? "text-brand" : recomputed.ok ? "text-muted" : "text-sell")}>
            {allOk ? "Verified" : recomputed.ok ? "Recomputed, on-chain check pending" : "Does not verify"}
          </span>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
          <div>
            <dt className="text-faint">SOL pot</dt>
            <dd className="font-semibold text-payout tabular">{formatSol(snapshot.solPot)}</dd>
          </div>
          <div>
            <dt className="text-faint">Token pot</dt>
            <dd className="font-semibold text-fg tabular">{formatTokens(snapshot.tokenPot)}</dd>
          </div>
          <div>
            <dt className="text-faint">Recipients</dt>
            <dd className="font-semibold text-fg tabular">{snapshot.entries.length}</dd>
          </div>
          <div>
            <dt className="text-faint">Eligible holders</dt>
            <dd className="font-semibold text-fg tabular">{snapshot.inputs.holders.length}</dd>
          </div>
        </dl>
      </Card>

      <div className="grid gap-3 md:grid-cols-3">
        <Check
          state={recomputed.ok ? "ok" : "fail"}
          title="Recomputed in your browser"
          detail={recomputed.ok ? "Every payout follows from the inputs: lots, weights, pot and parameters." : recomputed.problems.slice(0, 3).join("; ")}
        />
        <Check
          state={recomputed.problems.some((p) => p.includes("published")) ? "fail" : "ok"}
          title="Matches the published root"
          detail={`Merkle root ${snapshot.snapshotHash.slice(0, 24)}…`}
        />
        <Check state={chain.state} title="Matches the on-chain commitment" detail={chain.note} />
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-fg">Payouts</h2>
          <div className="flex items-center gap-2">
            {snapshot.openSig ? (
              <a href={explorerTxUrl(snapshot.openSig, SOLANA_CLUSTER)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-muted hover:text-fg">
                open_round <ExternalIcon size={11} />
              </a>
            ) : null}
            <Button size="sm" variant="outline" onClick={() => download(snapshot)}>
              Download JSON
            </Button>
          </div>
        </div>
        {snapshot.entries.length === 0 ? (
          <EmptyState title="No recipients" body="Nobody was above the minimum payout this round; the pot carries over." />
        ) : (
          <div className="scrollbar-thin max-h-[560px] overflow-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11px] font-semibold tracking-wider text-faint uppercase">
                  <th className="px-3 py-2">#</th>
                  <th className="px-3 py-2">Wallet</th>
                  <th className="px-3 py-2 text-right">SOL</th>
                  <th className="px-3 py-2 text-right">Tokens</th>
                  <th className="px-3 py-2" aria-label="Transaction" />
                </tr>
              </thead>
              <tbody>
                {snapshot.entries.map((e) => (
                  <tr key={e.index} className="border-b border-line/60 last:border-0">
                    <td className="px-3 py-2 text-xs text-faint tabular">{e.index}</td>
                    <td className="px-3 py-2">
                      <Link href={`/profile?wallet=${e.wallet}`} className="font-mono text-xs text-muted hover:text-fg">
                        {shortAddress(e.wallet, 5)}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-right font-semibold text-payout tabular">{formatSol(Number(e.solLamports) / 1e9)}</td>
                    <td className="px-3 py-2 text-right text-muted tabular">{formatTokens(Number(e.tokensRaw) / 10 ** 6)}</td>
                    <td className="px-3 py-2 text-right">
                      {e.sig ? (
                        <a href={explorerTxUrl(e.sig, SOLANA_CLUSTER)} target="_blank" rel="noopener noreferrer" className="text-faint hover:text-fg" aria-label="Payout transaction">
                          <ExternalIcon size={12} />
                        </a>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-4 text-xs text-muted">
        <div className="mb-1 font-semibold text-fg">Verify it yourself, offline</div>
        <code className="block overflow-x-auto rounded-lg bg-surface-2 p-2.5 font-mono text-[11px] whitespace-pre text-fg">
          {`pnpm --filter @holdfast/keeper verify-round -- --api ${API_URL} --mint ${mint} --round ${roundId} --rpc <RPC_URL>`}
        </code>
      </Card>
    </div>
  );
}
