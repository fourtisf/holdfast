/**
 * Launch state machine (docs/SPEC.md §5 "Launch flow"):
 *
 *   awaiting_deposit ──(balance ≥ required, funded before expiry)──► deposit_received ──► creating ──► live
 *         │                                                                                │
 *         ├─(expired, nothing arrived)──► expired                                          │ (N failures, vault never initialized)
 *         └─(expired / late / underpaid)──► refunding ──► refunded                         └────► refunding ──► failed
 *
 * `creating` runs: tx A (pump create_v2) → tx B (init_coin + reimbursement)
 * → tx C (dev buy, optional) → coins row → refund of everything left → live. Each step first checks
 * the chain (bonding curve / vault / sender token account exist?) so a crash or retry never repeats
 * an effect, every send is preceded by a DB write that bumps `updated_at`, and a launch in
 * `creating` / `refunding` is only resumed once that write is older than `inFlightGuardMs` (longer
 * than a blockhash lives), so a transaction broadcast before a crash has either landed or expired.
 * Refunds always send the whole balance (minus the fee), so two refunds can never both succeed.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { LAUNCH_FEE_LAMPORTS, PUMP_TOKEN_DECIMALS, type LaunchStatusKind } from "@holdfast/core";
import { coinKeys, deriveDepositKeypair, TOKEN_2022_PROGRAM_ID, type CoinKeys } from "@holdfast/chain";
import {
  addExcluded,
  ensureVaultState,
  getCoin,
  getLaunch,
  insertCoin,
  listPendingLaunches,
  notify,
  setLaunchSig,
  updateCoinMetadata,
  updateLaunchStatus,
  type Db,
  type ExcludedWallet,
  type LaunchPatch,
  type LaunchRow,
} from "@holdfast/db";

import { TxError, type LaunchChain } from "./chain.js";
import { computeLaunchCost, initReimbursement, rentFromChain, txFee, DEFAULT_PRIORITY, type PriorityConfig, type RentFn } from "@holdfast/chain";
import { decryptMintSecret, encryptMintSecret, mintSecretKey } from "./crypto.js";
import {
  buildMetadataJson,
  metadataUriLength,
  normalizeForm,
  ValidationError,
  writeMetadata,
  type LaunchForm,
  type MetadataSettings,
} from "./metadata.js";
import { pump, quoteDevBuy, readPumpBuyState } from "./pump.js";
import { PUMP_MAX_NAME_BYTES, PUMP_MAX_SYMBOL_BYTES, PUMP_USER_VOLUME_ACCUMULATOR_SIZE, SYSTEM_ACCOUNT_SIZE, TOKEN_2022_ATA_SIZE, utf8Len } from "@holdfast/chain";
import { forceLaunchSig, listRecentTerminalLaunches, setMintSecretOnce } from "./store.js";
import { buildCreateTx, buildDevBuyTx, buildInitTx, buildRefundTx, signTransaction, tokenAccountOf } from "./tx.js";

export interface Logger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface LauncherSettings {
  /** DEPOSIT_MASTER_SECRET (32 bytes): deposit keys and the mint-secret encryption key derive from it. */
  masterSecret: Buffer;
  /** Hot wallet; must equal the on-chain Config.launcher. */
  launcher: Keypair;
  metadata: MetadataSettings;
  priority: PriorityConfig;
  devBuySlippageBps: number;
  /** Close the deposit's pump volume accumulator in tx C (returns its rent to the deposit). */
  closeDepositAccumulator: boolean;
  /** Failed steps before a launch is given up (refund + failed; or, once the vault exists, dev buy skipped). */
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
  /** Minimum quiet time before resuming a creating/refunding launch (≥ blockhash lifetime). */
  inFlightGuardMs: number;
  /** A deposit whose funding transfer is at most this late (block time vs expires_at) still counts. */
  expiryGraceMs: number;
  /** How often finished launches are checked for late or leftover deposits, and how far back. */
  sweepIntervalMs: number;
  sweepLookbackMs: number;
  batchSize: number;
  /** Launches processed in parallel per tick. */
  concurrency: number;
}

export const DEFAULT_SETTINGS = {
  priority: DEFAULT_PRIORITY,
  devBuySlippageBps: 500,
  closeDepositAccumulator: true,
  maxAttempts: 6,
  retryBaseMs: 30_000,
  retryMaxMs: 10 * 60_000,
  inFlightGuardMs: 120_000,
  expiryGraceMs: 30_000,
  sweepIntervalMs: 5 * 60_000,
  sweepLookbackMs: 3 * 24 * 3600_000,
  batchSize: 500,
  concurrency: 4,
} satisfies Partial<LauncherSettings>;

export interface WorkerDeps {
  db: Db;
  chain: LaunchChain;
  settings: LauncherSettings;
  log: Logger;
  now?: () => number;
  /** Picks the pump buyback fee recipient for tx C among Global.buybackFeeRecipients (default: random). */
  pickBuybackRecipient?: (candidates: readonly PublicKey[]) => PublicKey;
}

type Step = "create" | "init" | "dev_buy" | "register" | "refund";

const describe = (err: unknown): string => {
  if (err instanceof TxError) return `${err.message} [${err.outcome}${err.signature ? ` ${err.signature}` : ""}]`;
  return err instanceof Error ? err.message : String(err);
};

export class LaunchWorker {
  private readonly db: Db;
  private readonly chain: LaunchChain;
  private readonly s: LauncherSettings;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly mintKey: Buffer;
  private rentFn: RentFn | null = null;
  private lastSweep = Number.NEGATIVE_INFINITY;
  private readonly underQuoted = new Set<string>();

  constructor(private readonly deps: WorkerDeps) {
    this.db = deps.db;
    this.chain = deps.chain;
    this.s = deps.settings;
    this.log = deps.log;
    this.now = deps.now ?? Date.now;
    this.mintKey = mintSecretKey(deps.settings.masterSecret);
  }

  /** One pass over every pending launch (+ the periodic sweep of finished ones). */
  async tick(): Promise<void> {
    const due = (await listPendingLaunches(this.db, { limit: this.s.batchSize })).filter((l) => this.isDue(l));
    const balances = await this.depositBalances(due.filter((l) => l.status === "awaiting_deposit"));
    // Launches are independent (own deposit, own mint; tx B reimburses the launcher atomically), so a
    // slow confirmation of one never holds back the others.
    let next = 0;
    const lane = async () => {
      while (next < due.length) {
        const launch = due[next++]!;
        try {
          await this.process(launch, balances.get(launch.id));
        } catch (err) {
          this.log.error({ launchId: launch.id, status: launch.status, err: describe(err) }, "launch processing error");
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.s.concurrency, due.length) }, lane));
    if (this.now() - this.lastSweep >= this.s.sweepIntervalMs) {
      this.lastSweep = this.now();
      await this.sweep();
    }
  }

  /** One RPC round trip per 100 deposit addresses instead of one per launch. */
  private async depositBalances(waiting: readonly LaunchRow[]): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    if (waiting.length === 0) return out;
    try {
      const balances = await this.chain.getBalances(waiting.map((l) => new PublicKey(l.depositAddress)));
      waiting.forEach((l, i) => out.set(l.id, balances[i]!));
    } catch (err) {
      this.log.warn({ err: describe(err) }, "batched deposit balance read failed; reading one by one");
    }
    return out;
  }

  async process(launch: LaunchRow, depositBalance?: bigint): Promise<void> {
    switch (launch.status) {
      case "awaiting_deposit":
        return this.watchDeposit(launch, depositBalance);
      case "deposit_received":
        return this.beginCreation(launch);
      case "creating":
        return this.create(launch);
      case "refunding":
        return this.refund(launch);
      default:
        return;
    }
  }

  isDue(l: LaunchRow): boolean {
    if (l.status === "awaiting_deposit" || l.status === "deposit_received") return true;
    const backoff = l.attempts === 0 ? 0 : Math.min(this.s.retryBaseMs * 2 ** (l.attempts - 1), this.s.retryMaxMs);
    return this.now() - l.updatedAt >= Math.max(backoff, this.s.inFlightGuardMs);
  }

  // ---- helpers -----------------------------------------------------------------------------------

  async rent(): Promise<RentFn> {
    this.rentFn ??= await rentFromChain((len) => this.chain.getMinimumBalanceForRentExemption(len));
    return this.rentFn;
  }

  private depositKeypair(l: LaunchRow): Keypair {
    const kp = deriveDepositKeypair(this.s.masterSecret, l.depositIndex);
    if (kp.publicKey.toBase58() !== l.depositAddress) throw new Error(`deposit address of launch ${l.id} does not match its derivation index`);
    return kp;
  }

  /** Status change (or same-status patch) + `launch` notification, atomically. Null if the row moved on. */
  private async transition(l: LaunchRow, status: LaunchStatusKind, patch: LaunchPatch, from: readonly LaunchStatusKind[]): Promise<LaunchRow | null> {
    const row = await this.db.tx(async (q) => {
      const updated = await updateLaunchStatus(q, l.id, status, patch, from);
      if (updated) await notify(q, { kind: "launch", launchId: l.id });
      return updated;
    });
    if (!row) this.log.warn({ launchId: l.id, from, to: status }, "launch changed concurrently; skipped");
    else if (status !== l.status) this.log.info({ launchId: l.id, from: l.status, to: status }, "launch status");
    return row;
  }

  /** Patch without changing status (bumps updated_at: done before every broadcast). */
  private async touch(l: LaunchRow, patch: LaunchPatch = {}): Promise<LaunchRow> {
    const row = await this.transition(l, l.status, patch, [l.status]);
    if (!row) throw new Error(`launch ${l.id} changed concurrently`);
    return row;
  }

  /** What the deposit must hold: the API's quote, raised to the real cost of this launch if needed. */
  async requiredLamports(l: LaunchRow): Promise<bigint> {
    const rent = await this.rent();
    // An invalid form is refunded once its deposit arrives, so it is quoted like a valid one.
    const nameBytes = Math.min(utf8Len((l.form.name ?? "").trim()), PUMP_MAX_NAME_BYTES);
    const symbolBytes = Math.min(utf8Len((l.form.ticker ?? "").trim()), PUMP_MAX_SYMBOL_BYTES);
    const cost = computeLaunchCost(rent, {
      nameBytes,
      symbolBytes,
      uriBytes: metadataUriLength(this.s.metadata.publicBaseUrl),
      priority: this.s.priority,
      devBuyLamports: l.devBuyLamports,
      closeDepositAccumulator: this.s.closeDepositAccumulator,
      devBuySlippageBps: this.s.devBuySlippageBps,
    });
    if (cost.requiredLamports > l.requiredLamports && !this.underQuoted.has(l.id)) {
      this.underQuoted.add(l.id);
      this.log.warn(
        { launchId: l.id, quoted: l.requiredLamports.toString(), required: cost.requiredLamports.toString(), specFee: LAUNCH_FEE_LAMPORTS.toString() },
        "launch quoted below its real cost; waiting for the real required amount",
      );
    }
    return cost.requiredLamports > l.requiredLamports ? cost.requiredLamports : l.requiredLamports;
  }

  // ---- awaiting_deposit ----------------------------------------------------------------------------

  private async watchDeposit(l: LaunchRow, knownBalance?: bigint): Promise<void> {
    const deposit = this.depositKeypair(l).publicKey;
    const required = await this.requiredLamports(l);
    const balance = knownBalance ?? (await this.chain.getBalance(deposit));
    const expired = this.now() > l.expiresAt;

    if (balance >= required) {
      const funding = await this.chain.findFundingSender(deposit);
      if (!funding) {
        this.log.info({ launchId: l.id, balance: balance.toString() }, "deposit seen; funding transfer not indexed yet");
        return;
      }
      const patch: LaunchPatch = { receivedLamports: balance, sender: funding.sender, depositSig: funding.signature };
      const onTime = !expired || (funding.blockTime !== null && funding.blockTime * 1000 <= l.expiresAt + this.s.expiryGraceMs);
      if (onTime) {
        const next = await this.transition(l, "deposit_received", { ...patch, error: null }, ["awaiting_deposit"]);
        if (next) await this.beginCreation(next);
      } else {
        const next = await this.transition(l, "refunding", patch, ["awaiting_deposit"]);
        if (next) await this.refund(next);
      }
      return;
    }

    if (expired) {
      if (balance === 0n) {
        await this.transition(l, "expired", {}, ["awaiting_deposit"]);
        return;
      }
      const funding = await this.chain.findFundingSender(deposit);
      if (!funding) return;
      const next = await this.transition(
        l,
        "refunding",
        { receivedLamports: balance, sender: funding.sender, depositSig: funding.signature },
        ["awaiting_deposit"],
      );
      if (next) await this.refund(next);
      return;
    }

    if (balance !== l.receivedLamports) await this.transition(l, "awaiting_deposit", { receivedLamports: balance }, ["awaiting_deposit"]);
  }

  // ---- deposit_received ----------------------------------------------------------------------------

  private async beginCreation(l: LaunchRow): Promise<void> {
    try {
      normalizeForm(l.form, this.s.metadata.publicBaseUrl);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      const next = await this.transition(l, "refunding", { error: `invalid launch: ${err.message}` }, ["deposit_received"]);
      if (next) await this.refund(next);
      return;
    }
    const withMint = l.mintSecret ? l : await setMintSecretOnce(this.db, l.id, encryptMintSecret(this.mintKey, l.id, Keypair.generate()));
    if (!withMint?.mintSecret) throw new Error(`could not store the mint keypair of launch ${l.id}`);
    const deposit = this.depositKeypair(l).publicKey;
    // Before anything can be bought: neither the deposit nor the launcher ever earns payouts.
    await addExcluded(this.db, [
      { address: deposit.toBase58(), reason: "deposit" },
      { address: this.s.launcher.publicKey.toBase58(), reason: "launcher" },
    ]);
    const next = await this.transition(withMint, "creating", { error: null }, ["deposit_received"]);
    if (next) await this.create(next);
  }

  // ---- creating ------------------------------------------------------------------------------------

  private async create(launch: LaunchRow): Promise<void> {
    let l = launch;
    let form: LaunchForm;
    try {
      form = normalizeForm(l.form, this.s.metadata.publicBaseUrl);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      const next = await this.transition(l, "refunding", { error: `invalid launch: ${err.message}` }, ["creating"]);
      if (next) await this.refund(next);
      return;
    }
    if (!l.mintSecret) {
      l = (await setMintSecretOnce(this.db, l.id, encryptMintSecret(this.mintKey, l.id, Keypair.generate()))) ?? l;
      if (!l.mintSecret) throw new Error(`could not store the mint keypair of launch ${l.id}`);
    }
    if (!l.sender) throw new Error(`launch ${l.id} is creating without a sender`);
    const deposit = this.depositKeypair(l);
    const mint = decryptMintSecret(this.mintKey, l.id, l.mintSecret);
    const coin = coinKeys(mint.publicKey, TOKEN_2022_PROGRAM_ID);
    const sender = new PublicKey(l.sender);
    const log = { launchId: l.id, mint: mint.publicKey.toBase58() };

    let step: Step = "create";
    try {
      const meta = await writeMetadata(buildMetadataJson(form, this.s.metadata.siteUrl), this.s.metadata);
      const rent = await this.rent();

      // A: pump.fun create_v2, creator = treasury PDA.
      if (!(await this.chain.accountExists(coin.bondingCurve))) {
        const tx = await buildCreateTx({
          deposit: deposit.publicKey,
          mint: mint.publicKey,
          name: form.name,
          symbol: form.symbol,
          uri: meta.uri,
          recent: await this.chain.latestBlockhash(),
          priority: this.s.priority,
        });
        const sig = signTransaction(tx, [deposit, mint]);
        l = await this.touch(l, { createSig: sig });
        await this.chain.sendAndConfirm(tx, [deposit, mint]);
        this.log.info({ ...log, sig, uri: meta.uri }, "coin created on pump.fun");
      }
      // The indexer only indexes mints it knows: register the coin as soon as it exists on-chain, so
      // trades between tx A and tx B (snipers) are not missed.
      step = "register";
      await this.registerCoin(form, coin, deposit.publicKey, sender, meta.uri, l.createSig, false);

      // B: init_coin, rent reimbursed to the launcher.
      step = "init";
      if (!(await this.chain.accountExists(coin.vault))) {
        const reimbursement = initReimbursement(rent, { treasuryLamports: await this.chain.getBalance(coin.treasury) });
        const tx = buildInitTx({
          deposit: deposit.publicKey,
          launcher: this.s.launcher.publicKey,
          mint: mint.publicKey,
          triggerBps: form.triggerBps,
          reimburseLamports: reimbursement.lamports,
          recent: await this.chain.latestBlockhash(),
          priority: this.s.priority,
        });
        const sig = signTransaction(tx, [deposit, this.s.launcher]);
        l = await this.touch(l);
        await this.chain.sendAndConfirm(tx, [deposit, this.s.launcher]);
        this.log.info({ ...log, sig, reimbursed: reimbursement.lamports.toString(), trigger: form.triggerBps }, "vault initialized");
      }

      // C: dev buy (deposit buys, tokens go to the sender by transfer: no lot, no payout).
      step = "dev_buy";
      let launchSig = l.createSig;
      let forceSig = false;
      let note: string | null = null;
      if (l.devBuyLamports > 0n) {
        if (await this.chain.accountExists(tokenAccountOf(sender, mint.publicKey))) {
          // tx C already landed (its signature was recorded as launch_sig before it was sent).
          launchSig = (await getCoin(this.db, mint.publicKey.toBase58()))?.launchSig ?? launchSig;
        } else if (l.attempts >= this.s.maxAttempts) {
          note = `dev buy skipped after ${l.attempts} failed attempts; its SOL was refunded`;
          forceSig = true;
          this.log.warn(log, note);
        } else {
          launchSig = await this.devBuy(l, form, coin, deposit, sender, meta.uri, rent);
          l = (await getLaunch(this.db, l.id)) ?? l;
        }
      }

      step = "register";
      await this.registerCoin(form, coin, deposit.publicKey, sender, meta.uri, launchSig, forceSig);

      step = "refund";
      let refundSig: string | undefined;
      try {
        refundSig = (await this.sendRefund(l, deposit, sender))?.signature;
      } catch (err) {
        if (l.attempts + 1 < this.s.maxAttempts) throw err;
        // The coin is live: do not hold the launch back, the sweep keeps retrying the refund.
        note = [note, `refund pending: ${describe(err)}`].filter(Boolean).join("; ");
        this.log.warn({ ...log, err: describe(err) }, "refund failed; left to the sweep");
      }
      await this.transition(l, "live", { mint: mint.publicKey.toBase58(), refundSig, error: note }, ["creating"]);
    } catch (err) {
      await this.onCreateFailure(l, step, err, coin);
    }
  }

  private async devBuy(
    l: LaunchRow,
    form: LaunchForm,
    coin: CoinKeys,
    deposit: Keypair,
    sender: PublicKey,
    uri: string,
    rent: RentFn,
  ): Promise<string> {
    const [state, balance, accumulatorExists] = await Promise.all([
      readPumpBuyState(this.chain, coin.mint, coin.tokenProgram),
      this.chain.getBalance(deposit.publicKey),
      this.chain.accountExists(pump.userVolumeAccumulatorPda(deposit.publicKey)),
    ]);
    // What has to stay (rent-exempt reserve + refund fee) and what tx C needs besides the buy itself.
    const reserve = rent(SYSTEM_ACCOUNT_SIZE) + txFee("refund", this.s.priority);
    const overhead =
      txFee("devBuy", this.s.priority) + 2n * rent(TOKEN_2022_ATA_SIZE) + (accumulatorExists ? 0n : rent(PUMP_USER_VOLUME_ACCUMULATOR_SIZE));
    const budget = balance - reserve - overhead;
    if (budget <= 0n) throw new Error(`deposit balance ${balance} cannot cover the dev buy`);
    const affordable = (budget * 10_000n) / BigInt(10_000 + this.s.devBuySlippageBps);
    const spend = l.devBuyLamports < affordable ? l.devBuyLamports : affordable;
    if (spend < l.devBuyLamports) this.log.warn({ launchId: l.id, requested: l.devBuyLamports.toString(), spend: spend.toString() }, "dev buy reduced to what the deposit covers");
    const quote = quoteDevBuy(state, spend, budget, this.s.devBuySlippageBps);
    const candidates = state.global.buybackFeeRecipients.filter((k) => !k.equals(PublicKey.default));
    if (candidates.length === 0) throw new Error("pump Global lists no buyback fee recipient");
    const pick = this.deps.pickBuybackRecipient ?? ((c: readonly PublicKey[]) => c[Math.floor(Math.random() * c.length)]!);
    const tx = await buildDevBuyTx({
      deposit: deposit.publicKey,
      sender,
      mint: coin.mint,
      tokens: quote.tokens,
      maxSolCost: quote.maxSolCost,
      bondingCurve: state.bondingCurve,
      buybackFeeRecipient: pick(candidates),
      closeAccumulator: this.s.closeDepositAccumulator,
      recent: await this.chain.latestBlockhash(),
      priority: this.s.priority,
    });
    const sig = signTransaction(tx, [deposit]);
    // The indexer must see this signature as the coin's launch_sig before it can see the transaction.
    await this.registerCoin(form, coin, deposit.publicKey, sender, uri, sig, true);
    await this.touch(l);
    await this.chain.sendAndConfirm(tx, [deposit]);
    this.log.info({ launchId: l.id, mint: coin.mint.toBase58(), sig, tokens: quote.tokens.toString(), cost: quote.cost.toString() }, "dev buy executed");
    return sig;
  }

  /** coins row (form details, creator = sender, PDAs) + exclusions, idempotent. */
  private async registerCoin(
    form: LaunchForm,
    coin: CoinKeys,
    deposit: PublicKey,
    sender: PublicKey,
    uri: string,
    launchSig: string | null,
    forceLaunchSigValue: boolean,
  ): Promise<void> {
    const mint = coin.mint.toBase58();
    const exclusions: ExcludedWallet[] = [
      { address: coin.vault.toBase58(), reason: "vault" },
      { address: coin.treasury.toBase58(), reason: "treasury" },
      { address: coin.bondingCurve.toBase58(), reason: "bonding_curve" },
      { address: deposit.toBase58(), reason: "deposit" },
      { address: this.s.launcher.publicKey.toBase58(), reason: "launcher" },
    ];
    await this.db.tx(async (q) => {
      const details = {
        name: form.name,
        ticker: form.symbol,
        imageUrl: form.imageUrl,
        description: form.description,
        socials: form.socials,
        creator: sender.toBase58(),
        metadataUri: uri,
      };
      const inserted = await insertCoin(q, {
        mint,
        ...details,
        triggerBps: form.triggerBps,
        vault: coin.vault.toBase58(),
        treasury: coin.treasury.toBase58(),
        bondingCurve: coin.bondingCurve.toBase58(),
        tokenProgram: coin.tokenProgram.toBase58(),
        decimals: PUMP_TOKEN_DECIMALS,
        launchSig,
      });
      // The indexer may have registered the coin first (from init_coin's CoinInitialized event).
      if (!inserted) await updateCoinMetadata(q, mint, details);
      if (launchSig) {
        if (forceLaunchSigValue) await forceLaunchSig(q, mint, launchSig);
        else await setLaunchSig(q, mint, launchSig);
      }
      await ensureVaultState(q, mint);
      await addExcluded(q, exclusions);
      await notify(q, { kind: "coin", mint });
    });
  }

  private async onCreateFailure(l: LaunchRow, step: Step, err: unknown, coin: CoinKeys): Promise<void> {
    const message = `${step}: ${describe(err)}`;
    const attempts = l.attempts + 1;
    this.log.warn({ launchId: l.id, mint: coin.mint.toBase58(), step, attempts, err: describe(err) }, "launch step failed");
    if (attempts < this.s.maxAttempts) {
      await this.touch(l, { error: message, incrementAttempts: true });
      return;
    }
    let created: boolean;
    let registered: boolean;
    try {
      created = await this.chain.accountExists(coin.bondingCurve);
      registered = created && (await this.chain.accountExists(coin.vault));
    } catch {
      await this.touch(l, { error: message, incrementAttempts: true });
      return;
    }
    if (registered) {
      // Coin and vault exist: only the dev buy or the final refund keep failing. With attempts ≥ max
      // the next pass skips the dev buy and finishes the launch (coins row, refund, live).
      await this.touch(l, { error: message, incrementAttempts: true });
      return;
    }
    const reason = created
      ? `launch failed after ${attempts} attempts (${message}); the coin exists on pump.fun but its vault was never initialized`
      : `launch failed after ${attempts} attempts (${message})`;
    if (created) this.log.error({ launchId: l.id, mint: coin.mint.toBase58() }, "coin created without a vault; needs a manual init_coin");
    const next = await this.transition(l, "refunding", { error: reason, incrementAttempts: true }, ["creating"]);
    if (next) await this.refund(next);
  }

  // ---- refunds -------------------------------------------------------------------------------------

  /**
   * Send everything on the deposit (minus this transaction's fee) to `sender`. Null when there is
   * nothing worth sending (already refunded, or dust an empty sender account could not receive).
   */
  private async sendRefund(l: LaunchRow, deposit: Keypair, sender: PublicKey): Promise<{ signature: string; lamports: bigint } | null> {
    const balance = await this.chain.getBalance(deposit.publicKey);
    const fee = txFee("refund", this.s.priority);
    if (balance <= fee) return null;
    const lamports = balance - fee;
    const rent = await this.rent();
    if (lamports < rent(SYSTEM_ACCOUNT_SIZE) && (await this.chain.getBalance(sender)) === 0n) {
      this.log.warn({ launchId: l.id, lamports: lamports.toString() }, "refund below the rent-exempt minimum of an empty account; left on the deposit");
      return null;
    }
    const tx = buildRefundTx({ deposit: deposit.publicKey, sender, lamports, recent: await this.chain.latestBlockhash(), priority: this.s.priority });
    const signature = signTransaction(tx, [deposit]);
    await this.touch(l, { refundSig: signature });
    await this.chain.sendAndConfirm(tx, [deposit]);
    this.log.info({ launchId: l.id, sender: sender.toBase58(), lamports: lamports.toString(), sig: signature }, "refund sent");
    return { signature, lamports };
  }

  /** `refunding` → `refunded` (expired / late / underpaid) or `failed` (launch error). Retried forever. */
  private async refund(launch: LaunchRow): Promise<void> {
    let l = launch;
    const deposit = this.depositKeypair(l);
    if (!l.sender) {
      const funding = await this.chain.findFundingSender(deposit.publicKey);
      if (!funding) {
        this.log.warn({ launchId: l.id }, "refund: sender not found yet");
        await this.touch(l, { incrementAttempts: true }); // back off
        return;
      }
      l = await this.touch(l, { sender: funding.sender });
    }
    const final: LaunchStatusKind = l.error ? "failed" : "refunded";
    try {
      const res = await this.sendRefund(l, deposit, new PublicKey(l.sender!));
      await this.transition(l, final, { refundSig: res?.signature }, ["refunding"]);
    } catch (err) {
      this.log.warn({ launchId: l.id, attempts: l.attempts + 1, err: describe(err) }, "refund failed; will retry");
      await this.touch(l, { incrementAttempts: true });
    }
  }

  /** Finished launches: refund deposits that arrived late (expired) or are left over (live/refunded/failed). */
  async sweep(): Promise<void> {
    const rows = await listRecentTerminalLaunches(this.db, this.now() - this.s.sweepLookbackMs, this.s.batchSize);
    const minimum = txFee("refund", this.s.priority);
    for (const l of rows) {
      try {
        const deposit = this.depositKeypair(l);
        const balance = await this.chain.getBalance(deposit.publicKey);
        if (balance <= minimum) continue;
        if (l.status === "expired") {
          const funding = await this.chain.findFundingSender(deposit.publicKey);
          if (!funding) continue;
          const next = await this.transition(
            l,
            "refunding",
            { receivedLamports: balance, sender: funding.sender, depositSig: funding.signature },
            ["expired"],
          );
          if (next) await this.refund(next);
          continue;
        }
        const sender = l.sender ?? (await this.chain.findFundingSender(deposit.publicKey))?.sender;
        if (!sender) continue;
        const res = await this.sendRefund(l, deposit, new PublicKey(sender));
        if (res && l.error?.includes("refund pending")) {
          const rest = l.error.replace(/;?\s*refund pending: .*$/s, "").trim();
          await this.transition(l, l.status, { error: rest === "" ? null : rest }, [l.status]);
        }
      } catch (err) {
        this.log.warn({ launchId: l.id, status: l.status, err: describe(err) }, "sweep refund failed");
      }
    }
  }
}
