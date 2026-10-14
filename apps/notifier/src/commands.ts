/** Bot commands: parsing and validation are pure; each command is one or two repository calls. */
import { PublicKey } from "@solana/web3.js";
import {
  addSubscription,
  getCoin,
  getCoins,
  listChatSubscriptions,
  removeChatSubscriptions,
  removeSubscription,
  type Queryable,
  type SubscriptionKind,
} from "@holdfast/db";

import { coinUrl, shortAddress, type Links } from "./format.js";
import { tickerText } from "./messages.js";
import { escapeHtml, type TgChat } from "./telegram.js";

/** Most subscriptions (wallets + coins) one chat may hold. */
export const MAX_SUBSCRIPTIONS_PER_CHAT = 20;

export interface ParsedCommand {
  name: string;
  args: string[];
}

/**
 * "/watch@HoldfastBot  <addr>" → { name: "watch", args: ["<addr>"] }. Null when `text` is not a
 * command, or is addressed to another bot (`@OtherBot`) in a group.
 */
export function parseCommand(text: string, botUsername?: string | null): ParsedCommand | null {
  const match = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{1,64}))?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const [, name, target, rest] = match;
  if (target && botUsername && target.toLowerCase() !== botUsername.toLowerCase()) return null;
  return { name: name!.toLowerCase(), args: rest ? rest.trim().split(/\s+/).filter(Boolean) : [] };
}

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** A base58 Solana address: 32–44 base58 characters that decode to exactly 32 bytes. */
export function isValidAddress(value: string): boolean {
  if (!BASE58_ADDRESS.test(value)) return false;
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

export interface CommandContext {
  db: Queryable;
  links: Links;
  now: () => number;
  maxSubscriptions?: number;
}

export function helpText(): string {
  return [
    "<b>Holdfast alerts</b>",
    "Every Holdfast coin's creator fees fund a floor vault (buybacks when the price drops to the floor), pay holders every 2 minutes weighted by how long they hold, and burn $HOLD. This bot tells you when that happens to you.",
    "",
    "/watch &lt;wallet&gt; - your payouts, and when a position reaches 0.5x and full weight",
    "/unwatch &lt;wallet&gt; - stop watching a wallet",
    "/coin &lt;mint&gt; - follow a coin: round results, floor defences, graduation",
    "/uncoin &lt;mint&gt; - unfollow a coin",
    "/list - what this chat follows",
    "/stop - remove everything for this chat",
    "/help - this message",
    "",
    `Up to ${MAX_SUBSCRIPTIONS_PER_CHAT} subscriptions per chat.`,
  ].join("\n");
}

const code = (s: string) => `<code>${escapeHtml(s)}</code>`;

function limitText(max: number): string {
  return `This chat already has ${max} subscriptions, the most allowed. Remove one with /unwatch or /uncoin first.`;
}

/** Validates the single address argument; returns the address or the reply explaining what is wrong. */
function addressArg(cmd: ParsedCommand, what: "wallet" | "mint"): { address: string } | { reply: string } {
  const usage = `Usage: /${cmd.name} &lt;${what} address&gt;`;
  if (cmd.args.length !== 1) return { reply: usage };
  const address = cmd.args[0]!;
  if (!isValidAddress(address)) return { reply: `${code(address.slice(0, 64))} is not a valid Solana address.\n${usage}` };
  return { address };
}

async function watch(ctx: CommandContext, chatId: number, cmd: ParsedCommand): Promise<string> {
  const arg = addressArg(cmd, "wallet");
  if ("reply" in arg) return arg.reply;
  const wallet = arg.address;
  const coin = await getCoin(ctx.db, wallet);
  if (coin) return `${code(shortAddress(wallet))} is the mint of $${tickerText(coin)}, not a wallet. Follow the coin with /coin ${wallet}`;
  return subscribed(ctx, chatId, "wallet", wallet, () =>
    [`👀 Watching wallet ${code(wallet)}.`, "You will get a message for every payout it receives, and when one of its positions reaches 0.5x and full weight."].join("\n"),
  );
}

async function follow(ctx: CommandContext, chatId: number, cmd: ParsedCommand): Promise<string> {
  const arg = addressArg(cmd, "mint");
  if ("reply" in arg) return arg.reply;
  const coin = await getCoin(ctx.db, arg.address);
  if (!coin) return `No Holdfast coin has the mint ${code(arg.address)}.`;
  return subscribed(ctx, chatId, "coin", coin.mint, () =>
    [
      `🔔 Following $${tickerText(coin)} (${escapeHtml(coin.name)}).`,
      "You will get every payout round's result, every floor defence and the graduation to PumpSwap.",
      `<a href="${escapeHtml(coinUrl(ctx.links, coin.mint))}">Coin page</a>`,
    ].join("\n"),
  );
}

async function subscribed(ctx: CommandContext, chatId: number, kind: SubscriptionKind, target: string, added: () => string): Promise<string> {
  const max = ctx.maxSubscriptions ?? MAX_SUBSCRIPTIONS_PER_CHAT;
  const result = await addSubscription(ctx.db, { chatId, kind, target, atMs: ctx.now() }, { limit: max });
  if (result === "limit") return limitText(max);
  if (result === "exists") return kind === "wallet" ? `Already watching ${code(target)}.` : `Already following ${code(target)}.`;
  return added();
}

async function unfollow(ctx: CommandContext, chatId: number, cmd: ParsedCommand, kind: SubscriptionKind): Promise<string> {
  const arg = addressArg(cmd, kind === "wallet" ? "wallet" : "mint");
  if ("reply" in arg) return arg.reply;
  const removed = await removeSubscription(ctx.db, chatId, kind, arg.address);
  if (kind === "wallet") return removed ? `Stopped watching ${code(arg.address)}.` : `This chat was not watching ${code(arg.address)}.`;
  return removed ? `Unfollowed ${code(arg.address)}.` : `This chat was not following ${code(arg.address)}.`;
}

async function list(ctx: CommandContext, chatId: number): Promise<string> {
  const subs = await listChatSubscriptions(ctx.db, chatId);
  if (subs.length === 0) return "This chat follows nothing yet. Try /watch &lt;wallet&gt; or /coin &lt;mint&gt;.";
  const wallets = subs.filter((s) => s.kind === "wallet");
  const coinSubs = subs.filter((s) => s.kind === "coin");
  const coins = await getCoins(ctx.db, coinSubs.map((s) => s.target));
  const lines = [`<b>This chat follows ${subs.length} of ${ctx.maxSubscriptions ?? MAX_SUBSCRIPTIONS_PER_CHAT}</b>`];
  if (wallets.length > 0) lines.push("", "Wallets:", ...wallets.map((s) => `• ${code(s.target)}`));
  if (coinSubs.length > 0) {
    lines.push("", "Coins:");
    for (const s of coinSubs) {
      const coin = coins.get(s.target);
      lines.push(coin ? `• $${tickerText(coin)} ${code(s.target)}` : `• ${code(s.target)}`);
    }
  }
  return lines.join("\n");
}

async function stop(ctx: CommandContext, chatId: number): Promise<string> {
  const n = await removeChatSubscriptions(ctx.db, chatId);
  return n === 0 ? "Nothing to remove: this chat follows nothing." : `Removed ${n} ${n === 1 ? "subscription" : "subscriptions"}. Send /start to begin again.`;
}

/** Runs a parsed command for `chatId`; returns the reply (HTML), or null for an unknown command. */
export async function runCommand(ctx: CommandContext, chatId: number, cmd: ParsedCommand): Promise<string | null> {
  switch (cmd.name) {
    case "start":
    case "help":
      return helpText();
    case "watch":
      return watch(ctx, chatId, cmd);
    case "unwatch":
      return unfollow(ctx, chatId, cmd, "wallet");
    case "coin":
      return follow(ctx, chatId, cmd);
    case "uncoin":
      return unfollow(ctx, chatId, cmd, "coin");
    case "list":
      return list(ctx, chatId);
    case "stop":
      return stop(ctx, chatId);
    default:
      return null;
  }
}

export interface TextResult {
  /** Metric label: the command name, "unknown" or "text". */
  command: string;
  reply: string;
}

/**
 * One incoming message. Commands run; anything else gets a pointer to /help in a private chat and is
 * ignored in groups and channels (where the bot sees other people's commands too).
 */
export async function handleText(ctx: CommandContext, chat: Pick<TgChat, "id" | "type">, text: string, botUsername?: string | null): Promise<TextResult | null> {
  const cmd = parseCommand(text, botUsername);
  const isPrivate = chat.type === "private";
  if (!cmd) return isPrivate ? { command: "text", reply: "Send /help to see what this bot can do." } : null;
  const reply = await runCommand(ctx, chat.id, cmd);
  if (reply !== null) return { command: cmd.name, reply };
  return isPrivate ? { command: "unknown", reply: `Unknown command /${escapeHtml(cmd.name)}. Send /help for the list.` } : null;
}
