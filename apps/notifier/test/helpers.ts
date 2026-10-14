import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { createPgliteDb, insertCoin, migrate, type Db, type NewCoin } from "@holdfast/db";

import type { Links } from "../src/format.js";
import type { TelegramApi, TgChat, TgUpdate, TgUser } from "../src/telegram.js";

export const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
export const MIN = 60_000;
export const H = 60 * MIN;
export const DAY = 24 * H;
/** One whole token (6 decimals). */
export const TOK = 1_000_000n;
export const LINKS: Links = { webUrl: "https://holdfast.example", cluster: "devnet" };

/** Deterministic base58 address for a label. */
export function addr(label: string): string {
  return new PublicKey(createHash("sha256").update(label).digest()).toBase58();
}

export async function freshDb(): Promise<Db> {
  const db = await createPgliteDb();
  await migrate(db);
  return db;
}

/** Empty every table (keeps the schema), much faster than booting a new PGlite. */
export async function resetDb(db: Db): Promise<void> {
  const res = await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'");
  await db.exec(`TRUNCATE ${res.rows.map((r) => `"${r.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
}

export async function seedCoin(db: Db, label: string, overrides: Partial<NewCoin> = {}): Promise<NewCoin> {
  const coin: NewCoin = {
    mint: addr(`mint:${label}`),
    name: `${label} coin`,
    ticker: label.toUpperCase().slice(0, 10),
    triggerBps: 2500,
    vault: addr(`vault:${label}`),
    treasury: addr(`treasury:${label}`),
    bondingCurve: addr(`curve:${label}`),
    tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    createdAt: NOW - 10 * DAY,
    ...overrides,
  };
  await insertCoin(db, coin);
  return coin;
}

export interface Sent {
  chatId: number;
  text: string;
}

/** Records sendMessage calls; getUpdates serves queued batches. `fail` makes sends to a chat throw. */
export class FakeTelegram implements TelegramApi {
  readonly sent: Sent[] = [];
  readonly offsets: number[] = [];
  readonly batches: TgUpdate[][] = [];
  readonly fail = new Map<number, Error>();
  onGetUpdates: (() => void) | null = null;

  async getMe(): Promise<TgUser> {
    return { id: 1, is_bot: true, first_name: "Holdfast", username: "HoldfastBot" };
  }

  async getUpdates(opts: { offset: number }): Promise<TgUpdate[]> {
    this.offsets.push(opts.offset);
    this.onGetUpdates?.();
    return (this.batches.shift() ?? []).filter((u) => u.update_id >= opts.offset);
  }

  async sendMessage(chatId: number, html: string): Promise<void> {
    const err = this.fail.get(chatId);
    if (err) throw err;
    this.sent.push({ chatId, text: html });
  }

  to(chatId: number): string[] {
    return this.sent.filter((s) => s.chatId === chatId).map((s) => s.text);
  }

  clear(): void {
    this.sent.length = 0;
  }
}

let messageId = 0;
export function textUpdate(updateId: number, chat: Pick<TgChat, "id" | "type">, text: string): TgUpdate {
  return { update_id: updateId, message: { message_id: ++messageId, date: Math.floor(NOW / 1000), chat, text } };
}
