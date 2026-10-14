/**
 * Devnet proof of concept: drives a running Holdfast stack end to end and checks every promise the
 * product makes, with real transactions.
 *
 *   pnpm --filter @holdfast/keeper devnet-poc -- --api http://localhost:4000 --rpc https://api.devnet.solana.com \
 *     --payer ~/.config/solana/devnet.json [--seed-fees 0.02] [--defend] [--out poc-report.json]
 *
 * Needs: the vault program deployed and initialized on devnet, and the api, indexer, launcher, keeper
 * and payout services running against it (docs/runbook.md, "Devnet proof of concept"). The payer
 * funds throwaway wallets (≈ 0.25 SOL in total) that play the creator and two holders.
 *
 *  1. preflight      RPC is devnet, program deployed, Config initialized and not paused, API healthy
 *  2. launch         upload an image, POST /launch, pay the deposit, wait for the coin to go live
 *  3. trade          two holders buy through /trade/build (signed locally) and the indexer sees them
 *  4. fees           creator fees reach the vault (optionally seeded: SOL sent to the pump.fun
 *                    creator vault of the coin is collected exactly like trading fees)
 *  5. payout         a payout round closes and pays the holders
 *  6. verify         the round recomputes from its inputs, its root matches the one committed in
 *                    open_round on-chain, and every payout transaction is confirmed
 *  7. defend         (--defend) holders dump, the vault buys back at the floor
 *
 * Writes a JSON report with every signature, and returns leftover SOL to the payer at the end.
 */
import { writeFileSync } from "node:fs";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, VersionedTransaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  roundOpenedFromLogs,
  verifyRoundSnapshot,
  type CoinDetail,
  type Holder,
  type LaunchQuote,
  type LaunchResponse,
  type LaunchStatus,
  type Position,
  type RoundSnapshot,
  type RoundSummary,
  type DefendEvent,
  type TradeBuildResponse,
} from "@holdfast/core";
import { creatorVaultPda, HOLDFAST_PROGRAM_ID, PUMP_PROGRAM_ID } from "@holdfast/chain";

import { Web3Chain } from "./chain.js";
import { loadKeypair } from "./config.js";
import { loadProgramConfig } from "./crank.js";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
// 1×1 PNG: the launch form needs an image.
const PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sol = (lamports: number | bigint) => Number(lamports) / LAMPORTS_PER_SOL;

interface StepRecord {
  name: string;
  ok: boolean;
  ms: number;
  detail?: unknown;
  error?: string;
}

const report: { startedAt: string; api: string; rpc: string; steps: StepRecord[]; mint?: string; wallets?: Record<string, string>; ok?: boolean } = {
  startedAt: new Date().toISOString(),
  api: "",
  rpc: "",
  steps: [],
};

async function step<T>(name: string, fn: () => Promise<T>, opts: { optional?: boolean } = {}): Promise<T | undefined> {
  const t0 = Date.now();
  process.stdout.write(`… ${name}\n`);
  try {
    const detail = await fn();
    report.steps.push({ name, ok: true, ms: Date.now() - t0, detail });
    console.log(`✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    return detail;
  } catch (err) {
    const error = (err as Error).message;
    report.steps.push({ name, ok: false, ms: Date.now() - t0, error });
    console.log(`${opts.optional ? "!" : "✗"} ${name}: ${error}`);
    if (!opts.optional) throw err;
    return undefined;
  }
}

/** Poll until `check` returns a value (not undefined/null/false), or fail after `timeoutMs`. */
async function until<T>(what: string, check: () => Promise<T | null | undefined | false>, timeoutMs: number, everyMs = 4_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < end) {
    try {
      const v = await check();
      if (v) return v;
    } catch (err) {
      lastErr = (err as Error).message;
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}${lastErr ? ` (last error: ${lastErr})` : ""}`);
}

async function main() {
  const api = (flag("api") ?? "http://localhost:4000").replace(/\/$/, "");
  const rpc = flag("rpc") ?? process.env.SOLANA_RPC_URL;
  const payerPath = flag("payer");
  const out = flag("out") ?? "poc-report.json";
  const seedFees = Number(flag("seed-fees") ?? "0.02");
  const buySol = Number(flag("buy") ?? "0.05");
  const scale = Number(flag("timeout-scale") ?? "1");
  if (!rpc || !payerPath) throw new Error("usage: devnet-poc --api <url> --rpc <url> --payer <keypair.json> [--seed-fees SOL] [--buy SOL] [--defend] [--out file]");
  report.api = api;
  report.rpc = rpc;

  const connection = new Connection(rpc, "confirmed");
  const payer = loadKeypair(payerPath);
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${api}${path}`);
    if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const res = await fetch(`${api}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`POST ${path}: HTTP ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };
  const transfer = async (from: Keypair, to: PublicKey, lamports: number) =>
    sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports })), [from], { commitment: "confirmed" });

  // 1. preflight -------------------------------------------------------------------------------
  const quote = (await step("preflight", async () => {
    const genesis = await connection.getGenesisHash().catch((err: Error) => {
      throw new Error(`RPC ${rpc} unreachable: ${err.message}`);
    });
    if (genesis === MAINNET_GENESIS && !has("allow-mainnet")) throw new Error("this RPC is mainnet; the PoC spends real SOL there (pass --allow-mainnet to insist)");
    if (genesis !== DEVNET_GENESIS && genesis !== MAINNET_GENESIS) console.log(`  note: unknown cluster (genesis ${genesis}), assuming a local validator with pump.fun cloned`);
    const [program, pump] = await connection.getMultipleAccountsInfo([HOLDFAST_PROGRAM_ID, PUMP_PROGRAM_ID]);
    if (!program?.executable) throw new Error(`Holdfast program ${HOLDFAST_PROGRAM_ID.toBase58()} is not deployed on this cluster`);
    if (!pump?.executable) throw new Error("pump.fun is not deployed on this cluster");
    const config = await loadProgramConfig(new Web3Chain(connection, 0));
    if (config.paused) throw new Error("the vault program is paused");
    await get<{ ok: boolean }>("/healthz").catch((err: Error) => {
      throw new Error(`API ${api} unreachable: ${err.message}`);
    });
    const q = await get<LaunchQuote>("/launch/quote");
    const balance = await connection.getBalance(payer.publicKey);
    const need = (q.requiredSol + 2 * (buySol + 0.03) + seedFees + 0.03) * LAMPORTS_PER_SOL;
    if (balance < need) throw new Error(`payer ${payer.publicKey.toBase58()} has ${sol(balance)} SOL, needs ≈ ${sol(need).toFixed(3)} (solana airdrop 2 --url devnet)`);
    return { genesis, keeper: config.keeper.toBase58(), launcher: config.launcher.toBase58(), launchQuoteSol: q.requiredSol, payerSol: sol(balance), quote: q };
  }))!.quote;

  // throwaway wallets, saved so nothing is lost if the run dies
  const creator = Keypair.generate();
  const holders = [Keypair.generate(), Keypair.generate()];
  report.wallets = Object.fromEntries([["creator", creator], ["holderA", holders[0]!], ["holderB", holders[1]!]].map(([k, kp]) => [k as string, JSON.stringify(Array.from((kp as Keypair).secretKey))]));
  writeFileSync(out, JSON.stringify(report, null, 2));

  try {
    await step("fund test wallets", async () => {
      await transfer(payer, creator.publicKey, Math.ceil((quote.requiredSol + 0.01) * LAMPORTS_PER_SOL));
      for (const h of holders) await transfer(payer, h.publicKey, Math.ceil((buySol + 0.03) * LAMPORTS_PER_SOL));
      return { creator: creator.publicKey.toBase58(), holders: holders.map((h) => h.publicKey.toBase58()) };
    });

    // 2. launch ----------------------------------------------------------------------------------
    const mint = (await step("launch through the deposit flow", async () => {
      const form = new FormData();
      form.append("file", new Blob([PIXEL_PNG], { type: "image/png" }), "poc.png");
      const up = await fetch(`${api}/uploads/image`, { method: "POST", body: form });
      if (!up.ok) throw new Error(`upload: HTTP ${up.status} ${await up.text()}`);
      const { imageUrl } = (await up.json()) as { imageUrl: string };
      const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
      const launch = await post<LaunchResponse>("/launch", { name: `Holdfast PoC ${tag}`, ticker: `POC${tag}`.slice(0, 10), description: "Devnet proof of concept", imageUrl, triggerBps: 2500 });
      const depositSig = await transfer(creator, new PublicKey(launch.depositAddress), Number(launch.requiredLamports));
      const status = await until(
        "the launch to go live",
        async () => {
          const s = await get<LaunchStatus>(`/launch/${launch.launchId}`);
          if (s.status === "refunded" || s.status === "failed" || s.status === "expired") throw new Error(`launch ended as ${s.status}: ${s.error ?? ""}`);
          return s.status === "live" && s.mint ? s : null;
        },
        5 * 60_000 * scale,
      );
      report.mint = status.mint!;
      return { launchId: launch.launchId, depositSig, requiredSol: launch.requiredSol, mint: status.mint };
    }))!.mint!;

    const coin = (await step("coin indexed", () => until("GET /coins/:mint", () => get<CoinDetail>(`/coins/${mint}`), 2 * 60_000 * scale)))!;

    // 3. trade -----------------------------------------------------------------------------------
    await step("holders buy on the bonding curve", async () => {
      const sigs: string[] = [];
      for (const [i, h] of holders.entries()) {
        const built = await post<TradeBuildResponse>("/trade/build", { mint, wallet: h.publicKey.toBase58(), side: "buy", amount: buySol * (i === 0 ? 1 : 0.6), slippageBps: 1_000 });
        const tx = VersionedTransaction.deserialize(Buffer.from(built.transaction, "base64"));
        tx.sign([h]);
        const sig = await connection.sendRawTransaction(tx.serialize());
        const res = await connection.confirmTransaction({ signature: sig, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: built.lastValidBlockHeight }, "confirmed");
        if (res.value.err) throw new Error(`buy ${sig} failed: ${JSON.stringify(res.value.err)}`);
        sigs.push(sig);
      }
      return { sigs };
    });

    await step("indexer tracks both holders with purchase lots", () =>
      until(
        "both holders in /holders",
        async () => {
          const list = await get<Holder[]>(`/coins/${mint}/holders?limit=500`);
          const found = holders.map((h) => list.find((x) => x.wallet === h.publicKey.toBase58()));
          return found.every((x) => x && x.eligibleTokens > 0) ? found.map((x) => ({ wallet: x!.wallet, tokens: x!.tokens, weight: x!.weightMultiplier })) : null;
        },
        3 * 60_000 * scale,
      ),
    );

    // 4. fees ------------------------------------------------------------------------------------
    if (seedFees > 0) {
      await step(`seed ${seedFees} SOL of creator fees`, async () => {
        // The coin's pump.fun creator is its treasury PDA, so this is exactly where trading fees accrue.
        const vault = creatorVaultPda(new PublicKey(coin.treasuryAddress));
        return { creatorVault: vault.toBase58(), sig: await transfer(payer, vault, Math.round(seedFees * LAMPORTS_PER_SOL)) };
      });
    }
    await step("keeper collects fees into the vault (60 / 30 / 10)", () =>
      until(
        "fees in the vault",
        async () => {
          const c = await get<CoinDetail>(`/coins/${mint}`);
          return c.vault.floorSol > 0 && (c.vault.holderSol > 0 || c.paidOutSol > 0) ? { floorSol: c.vault.floorSol, holderSol: c.vault.holderSol, burnSol: c.vault.burnSol } : null;
        },
        6 * 60_000 * scale,
      ),
    );

    // 5. payout ----------------------------------------------------------------------------------
    const round = (await step("a payout round closes and pays holders", () =>
      until(
        "a closed round with recipients",
        async () => {
          const rounds = await get<RoundSummary[]>(`/coins/${mint}/rounds?limit=20`);
          return rounds.find((r) => r.status === "closed" && r.recipients > 0) ?? null;
        },
        15 * 60_000 * scale,
        10_000,
      ),
    ))!;

    // 6. verify ----------------------------------------------------------------------------------
    await step("round verifies against its inputs and the on-chain commitment", async () => {
      const snapshot = await get<RoundSnapshot>(`/coins/${mint}/rounds/${round.roundId}`);
      if (!snapshot.openSig) throw new Error("round has no open_round signature");
      const tx = await connection.getTransaction(snapshot.openSig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      const committed = roundOpenedFromLogs(tx?.meta?.logMessages ?? []).find((e) => e.mint === mint && e.roundId === round.roundId);
      if (!committed) throw new Error(`no RoundOpened event in ${snapshot.openSig}`);
      const result = verifyRoundSnapshot(snapshot, committed.snapshotHash);
      if (!result.ok) throw new Error(result.problems.join("; "));
      const sigs = snapshot.entries.map((e) => e.sig).filter((s): s is string => Boolean(s));
      const statuses = sigs.length ? (await connection.getSignatureStatuses(sigs, { searchTransactionHistory: true })).value : [];
      const unconfirmed = sigs.filter((_, i) => !statuses[i] || statuses[i]!.err);
      if (unconfirmed.length) throw new Error(`payout transactions not confirmed: ${unconfirmed.join(", ")}`);
      const paidHolders = holders.filter((h) => snapshot.entries.some((e) => e.wallet === h.publicKey.toBase58()));
      return { roundId: round.roundId, root: committed.snapshotHash, recipients: snapshot.entries.length, payoutTxs: sigs.length, paidTestHolders: paidHolders.length };
    });

    await step("positions show weights and earnings", async () => {
      const p = await get<Position | null>(`/me/position?wallet=${holders[0]!.publicKey.toBase58()}&mint=${mint}`);
      if (!p || !(p.weightMultiplier >= 0.1)) throw new Error(`unexpected position ${JSON.stringify(p)}`);
      return { weight: p.weightMultiplier, share: p.share, earnedSol: p.earnedSol, pnlSol: p.pnlSol };
    });

    // 7. defend (optional) -------------------------------------------------------------------------
    if (has("defend")) {
      await step(
        "vault defends the floor after holders dump",
        async () => {
          for (const h of holders) {
            const pos = await get<Position | null>(`/me/position?wallet=${h.publicKey.toBase58()}&mint=${mint}`);
            if (!pos || pos.tokens <= 0) continue;
            const built = await post<TradeBuildResponse>("/trade/build", { mint, wallet: h.publicKey.toBase58(), side: "sell", amount: pos.tokens, slippageBps: 2_000 });
            const tx = VersionedTransaction.deserialize(Buffer.from(built.transaction, "base64"));
            tx.sign([h]);
            await connection.confirmTransaction({ signature: await connection.sendRawTransaction(tx.serialize()), blockhash: tx.message.recentBlockhash, lastValidBlockHeight: built.lastValidBlockHeight }, "confirmed");
          }
          const defends = await until("a vault buyback", async () => {
            const d = await get<DefendEvent[]>(`/coins/${mint}/defends`);
            return d.length > 0 ? d : null;
          }, 10 * 60_000 * scale, 10_000);
          return { defends: defends.length, first: defends[defends.length - 1] };
        },
        // Whether the price reaches the floor depends on the curve depth and the TWAP-based ATH.
        { optional: true },
      );
    }
    report.ok = report.steps.every((s) => s.ok || s.name.startsWith("vault defends"));
  } finally {
    await step(
      "return leftover SOL to the payer",
      async () => {
        let returned = 0;
        for (const kp of [creator, ...holders]) {
          const bal = await connection.getBalance(kp.publicKey);
          if (bal > 10_000) {
            await transfer(kp, payer.publicKey, bal - 5_000);
            returned += bal - 5_000;
          }
        }
        return { returnedSol: sol(returned) };
      },
      { optional: true },
    );
    writeFileSync(out, JSON.stringify(report, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    console.log(`\nreport: ${out}`);
  }
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nPoC failed: ${(err as Error).message}`);
  writeFileSync(flag("out") ?? "poc-report.json", JSON.stringify({ ...report, ok: false }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  process.exit(1);
});
