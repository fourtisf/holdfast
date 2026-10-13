/**
 * Independent round verification (spec §5.5 / §7.3):
 *
 *   pnpm --filter @holdfast/keeper verify-round -- --api https://api.holdfast.example --mint <MINT> --round <ID> [--rpc <URL>]
 *
 * Downloads the public snapshot, recomputes every payout from its inputs with @holdfast/core, checks
 * the merkle root, and (with --rpc) compares it with the root committed on-chain by `open_round`.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { toHex, verifyRoundSnapshot, type RoundSnapshot } from "@holdfast/core";
import { HOLDFAST_PROGRAM_ID, parseHoldfastEvents, roundPda } from "@holdfast/chain";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function onChainRoot(rpc: string, mint: string, roundId: number): Promise<string | null> {
  const connection = new Connection(rpc, "confirmed");
  const sigs = await connection.getSignaturesForAddress(roundPda(new PublicKey(mint), BigInt(roundId)), { limit: 1000 });
  for (const s of sigs.reverse()) {
    const tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
    for (const ev of parseHoldfastEvents(tx?.meta?.logMessages ?? [], HOLDFAST_PROGRAM_ID)) {
      if (ev.name === "RoundOpened" && ev.mint.toBase58() === mint && Number(ev.roundId) === roundId) return toHex(ev.snapshotHash);
    }
  }
  return null;
}

async function main() {
  const api = arg("api");
  const mint = arg("mint");
  const round = Number(arg("round"));
  if (!api || !mint || !Number.isInteger(round)) throw new Error("usage: --api <url> --mint <mint> --round <id> [--rpc <url>]");
  const res = await fetch(`${api.replace(/\/$/, "")}/coins/${mint}/rounds/${round}`);
  if (!res.ok) throw new Error(`snapshot fetch failed: ${res.status}`);
  const snapshot = (await res.json()) as RoundSnapshot;

  const rpc = arg("rpc");
  const chainRoot = rpc ? await onChainRoot(rpc, mint, round) : undefined;
  if (rpc && !chainRoot) console.warn("RoundOpened event not found on-chain (round too old for the RPC's history?)");
  const result = verifyRoundSnapshot(snapshot, chainRoot ?? undefined);
  console.log(JSON.stringify({ mint, round, recipients: snapshot.entries.length, root: snapshot.snapshotHash, onChainRoot: chainRoot ?? null, ...result }, null, 2));
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(2);
});
