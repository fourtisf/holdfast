"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { CoinDetail } from "@holdfast/core";
import { useState } from "react";
import { useSWRConfig } from "swr";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { ErrorNote } from "@/components/ui/States";
import { CoinsIcon, ExternalIcon } from "@/components/ui/icons";
import { api, errorMessage } from "@/lib/api";
import { SOLANA_CLUSTER } from "@/lib/config";
import { explorerTxUrl } from "@/lib/explorer";
import { formatSol } from "@/lib/format";
import { keys } from "@/lib/hooks/queries";
import { confirmSignature, decodeTransaction } from "@/lib/solana";

type Phase = "idle" | "building" | "signing" | "confirming" | "done" | "error";

/**
 * Shown to the coin's creator only: its 15% of the fees, claimable from the vault. The program pays it
 * to the creator wallet recorded at launch and checks that wallet's signature itself.
 */
export function CreatorClaimCard({ coin }: { coin: CoinDetail }) {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const { mutate } = useSWRConfig();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [claimed, setClaimed] = useState<number | null>(null);
  const v = coin.vault;
  const busy = phase === "building" || phase === "signing" || phase === "confirming";

  const claim = async () => {
    if (!publicKey) return;
    setError(null);
    setSignature(null);
    try {
      setPhase("building");
      const built = await api.buildCreatorClaim({ mint: coin.mint, wallet: publicKey.toBase58() });
      const tx = decodeTransaction(built.transaction);
      setPhase("signing");
      const sig = await sendTransaction(tx, connection);
      setSignature(sig);
      setPhase("confirming");
      await confirmSignature(connection, sig, tx, built.lastValidBlockHeight);
      setClaimed(built.claimableSol);
      setPhase("done");
      setTimeout(() => void mutate(keys.coin(coin.mint)), 1500);
    } catch (err) {
      const msg = errorMessage(err);
      setError(/reject|cancel|denied/i.test(msg) ? "Cancelled in wallet." : msg);
      setPhase("error");
    }
  };

  const label =
    phase === "building" ? "Preparing…" : phase === "signing" ? "Approve in wallet…" : phase === "confirming" ? "Confirming…" : `Claim ${formatSol(v.creatorSol)}`;

  return (
    <Card>
      <CardHeader title="Your creator fees" icon={<CoinsIcon size={15} />} subtitle="15% of this coin's fees, claimable by you only" />
      <div className="mx-4 rounded-control bg-creator/8 px-3 py-3 ring-1 ring-creator/25">
        <div className="text-[11px] font-semibold tracking-wider text-creator uppercase">Claimable now</div>
        <div className="mt-0.5 text-2xl font-semibold text-creator tabular">{formatSol(v.creatorSol)}</div>
        <div className="text-xs text-muted">{v.creatorClaimedSol > 0 ? `${formatSol(v.creatorClaimedSol)} claimed so far` : "Nothing claimed yet"}</div>
      </div>
      <div className="p-4 pt-3">
        <Button className="w-full" onClick={claim} disabled={busy || v.creatorSol <= 0}>
          {v.creatorSol <= 0 && !busy ? "Nothing to claim yet" : label}
        </Button>
        {phase === "done" && claimed !== null ? <p className="mt-2 text-xs text-buy">Claimed {formatSol(claimed)} to your wallet.</p> : null}
        {error ? <ErrorNote className="mt-2">{error}</ErrorNote> : null}
        {signature ? (
          <a href={explorerTxUrl(signature, SOLANA_CLUSTER)} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
            View transaction <ExternalIcon size={12} />
          </a>
        ) : null}
        <p className="mt-2 text-[11px] text-faint">Fees reach the vault every couple of minutes. The floor and holder funds stay locked in the vault.</p>
      </div>
    </Card>
  );
}
