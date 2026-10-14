import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { deriveDepositKeypair } from "@holdfast/chain";
import type { LaunchRequest } from "@holdfast/core";
import {
  createPgliteDb,
  getLaunch,
  HOLDFAST_EVENTS_CHANNEL,
  insertLaunch,
  migrate,
  nextDepositIndex,
  parseNotification,
  type Db,
  type HoldfastNotification,
  type LaunchRow,
} from "@holdfast/db";

import { computeLaunchCost, DEFAULT_IPFS_GATEWAY, DEFAULT_PRIORITY, DEFAULT_RENT, launchCostOptions } from "@holdfast/chain";
import { launchLookupAddresses } from "../src/lookup.js";
import { pump, quoteDevBuy, type DevBuyQuote } from "../src/pump.js";
import { utf8Len } from "@holdfast/chain";
import { DEFAULT_SETTINGS, LaunchWorker, type LauncherSettings, type Logger } from "../src/worker.js";
import { FakeChain } from "./fakeChain.js";

export const MASTER = Buffer.alloc(32, 7);
export const BASE_URL = "https://api.holdfast.test/metadata";
export const SITE = "https://holdfast.test";
export const SOL = 1_000_000_000n;

export async function freshDb(): Promise<Db> {
  const db = await createPgliteDb();
  await migrate(db);
  return db;
}

export async function resetDb(db: Db): Promise<void> {
  const res = await db.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'",
  );
  await db.exec(`TRUNCATE ${res.rows.map((r) => `"${r.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
}

export const defaultForm = (): LaunchRequest => ({
  name: "Holdfast Test",
  ticker: "HFT",
  description: "a coin that defends its floor",
  imageUrl: `${BASE_URL}/images/abc123.png`,
  socials: { x: "https://x.com/holdfast", telegram: "https://t.me/holdfast", website: "https://holdfast.test" },
  triggerBps: 2500,
});

export interface LogLine {
  level: string;
  obj: object;
  msg?: string;
}

export class Harness {
  /** Starts at wall-clock time: `updated_at` is written by the database's now(). */
  readonly clock = { now: Date.now() };
  readonly launcher = Keypair.generate();
  readonly notes: HoldfastNotification[] = [];
  readonly logs: LogLine[] = [];
  readonly chain: FakeChain;
  readonly settings: LauncherSettings;
  worker: LaunchWorker;
  private unlisten: (() => Promise<void>) | null = null;

  private constructor(
    readonly db: Db,
    overrides: Partial<LauncherSettings>,
    configLauncher?: PublicKey,
  ) {
    this.chain = new FakeChain({ now: () => this.clock.now, configLauncher: configLauncher ?? this.launcher.publicKey });
    this.chain.airdrop(this.launcher.publicKey, SOL / 10n);
    this.settings = {
      ...DEFAULT_SETTINGS,
      masterSecret: MASTER,
      launcher: this.launcher,
      metadata: { storeDir: mkdtempSync(join(tmpdir(), "holdfast-meta-")), publicBaseUrl: BASE_URL, siteUrl: SITE },
      metadataLocation: { kind: "local", publicBaseUrl: BASE_URL, gatewayUrl: DEFAULT_IPFS_GATEWAY },
      maxAttempts: 3,
      retryBaseMs: 1_000,
      retryMaxMs: 10_000,
      inFlightGuardMs: 5_000,
      expiryGraceMs: 0,
      sweepIntervalMs: 0,
      ...overrides,
    };
    this.worker = this.newWorker();
  }

  /** `atomic`: the launcher gets an address lookup table (what `alt create` builds), so launches are one transaction. */
  static async create(db: Db, overrides: Partial<LauncherSettings> & { atomic?: boolean } = {}, configLauncher?: PublicKey): Promise<Harness> {
    const { atomic, ...rest } = overrides;
    const h = new Harness(db, rest, configLauncher);
    if (atomic) {
      const table = Keypair.generate().publicKey;
      h.chain.addLookupTable(table, await launchLookupAddresses(h.chain.global, h.launcher.publicKey));
      (h.settings as { lookupTable: PublicKey | null }).lookupTable = table;
      h.worker = h.newWorker();
    }
    h.unlisten = await db.listen(HOLDFAST_EVENTS_CHANNEL, (payload) => {
      const n = parseNotification(payload);
      if (n) h.notes.push(n);
    });
    return h;
  }

  async close(): Promise<void> {
    await this.unlisten?.();
    rmSync(this.settings.metadata.storeDir, { recursive: true, force: true });
  }

  readonly logger: Logger = {
    debug: (obj, msg) => this.logs.push({ level: "debug", obj, msg }),
    info: (obj, msg) => this.logs.push({ level: "info", obj, msg }),
    warn: (obj, msg) => this.logs.push({ level: "warn", obj, msg }),
    error: (obj, msg) => this.logs.push({ level: "error", obj, msg }),
  };

  newWorker(): LaunchWorker {
    return new LaunchWorker({
      db: this.db,
      chain: this.chain,
      settings: this.settings,
      log: this.logger,
      now: () => this.clock.now,
      pickBuybackRecipient: (c) => c[0]!,
    });
  }

  /** What a correct API quotes for this form (the launcher's own cost model). */
  quote(form: LaunchRequest, devBuyLamports = 0n): bigint {
    return computeLaunchCost(
      DEFAULT_RENT,
      launchCostOptions(
        {
          mode: this.settings.lookupTable ? "atomic" : "split",
          metadata: this.settings.metadataLocation,
          priority: this.settings.priority,
          devBuySlippageBps: this.settings.devBuySlippageBps,
          closeDepositAccumulator: this.settings.closeDepositAccumulator,
        },
        { nameBytes: utf8Len(form.name.trim()), symbolBytes: utf8Len(form.ticker.trim()), devBuyLamports },
      ),
    ).requiredLamports;
  }

  async launch(
    form: LaunchRequest = defaultForm(),
    opts: { devBuyLamports?: bigint; requiredLamports?: bigint; ttlMs?: number } = {},
  ): Promise<{ row: LaunchRow; deposit: Keypair; required: bigint }> {
    const devBuyLamports = opts.devBuyLamports ?? 0n;
    const index = await nextDepositIndex(this.db);
    const deposit = deriveDepositKeypair(MASTER, index);
    const required = opts.requiredLamports ?? this.quote(form, devBuyLamports);
    const row = await insertLaunch(this.db, {
      id: randomUUID(),
      form,
      depositAddress: deposit.publicKey.toBase58(),
      depositIndex: index,
      requiredLamports: required,
      devBuyLamports,
      expiresAt: this.clock.now + (opts.ttlMs ?? 30 * 60_000),
    });
    return { row, deposit, required };
  }

  async tick(times = 1): Promise<void> {
    for (let i = 0; i < times; i++) await this.worker.tick();
  }

  advance(ms: number): void {
    this.clock.now += ms;
  }

  /** Past the in-flight guard (with a margin for the real time the test itself takes). */
  advancePastGuard(): void {
    this.advance(this.settings.inFlightGuardMs + 2_000);
  }

  async row(id: string): Promise<LaunchRow> {
    const row = await getLaunch(this.db, id);
    if (!row) throw new Error(`launch ${id} not found`);
    return row;
  }

  /** NOTIFY delivery is asynchronous. */
  async flush(): Promise<void> {
    await new Promise((r) => setTimeout(r, 30));
  }

  launchNotes(id: string): number {
    return this.notes.filter((n) => n.kind === "launch" && n.launchId === id).length;
  }

  /** The dev-buy quote the launcher computes on a freshly created curve. */
  freshCurveQuote(creator: PublicKey, devBuy: bigint): DevBuyQuote {
    const g = this.chain.global;
    return quoteDevBuy(
      {
        global: g,
        feeConfig: this.chain.feeConfig,
        bondingCurve: { ...pump.newBondingCurve(g), creator },
        mintSupply: g.tokenTotalSupply,
        curveBaseTokenBalance: new BN(g.tokenTotalSupply.toString()),
      },
      devBuy,
      10n * devBuy,
      this.settings.devBuySlippageBps,
    );
  }
}

export { DEFAULT_PRIORITY };
