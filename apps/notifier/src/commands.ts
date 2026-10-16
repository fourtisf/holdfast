/**
 * Bot commands. Parsing and validation are pure; each command is a few repository or API calls and
 * returns one reply (HTML plus optional inline buttons).
 */
import {
  addSubscription,
  getBuybot,
  getCoin,
  getCoins,
  listChatSubscriptions,
  removeBuybot,
  removeChatSubscriptions,
  removeSubscription,
  setBuybot,
  type Queryable,
  type SubscriptionKind,
} from "@holdfast/db";

import type { MoatpadApi } from "./api.js";
import { isValidAddress } from "./address.js";
import { botLink, clip, coinUrl, shortAddress } from "./format.js";
import type { LaunchFlow } from "./launch.js";
import { burnsMessage, coinCard, helpMessage, MENU, tickerText, trendingMessage, welcomeMessage, type BotLinks, type BotReply } from "./messages.js";
import { escapeHtml, type BotCommandSpec, type TelegramApi, type TgChat, type TgUser } from "./telegram.js";

export { isValidAddress };

/** Most subscriptions (wallets + coins) one chat may hold. */
export const MAX_SUBSCRIPTIONS_PER_CHAT = 20;

/** The "/" menu in private chats. */
export const PRIVATE_COMMANDS: readonly BotCommandSpec[] = [
  { command: "launch", description: "Launch a new coin" },
  { command: "coin", description: "Look up a coin by its address" },
  { command: "trending", description: "Top coins right now" },
  { command: "burns", description: "$MOATPAD buy & burn" },
  { command: "buybot", description: "Buy alerts for your group" },
  { command: "follow", description: "Alerts for a coin" },
  { command: "unfollow", description: "Turn off a coin's alerts" },
  { command: "watch", description: "Payout alerts for your wallet" },
  { command: "unwatch", description: "Stop watching a wallet" },
  { command: "alerts", description: "What this chat follows" },
  { command: "stop", description: "Turn off every alert here" },
  { command: "cancel", description: "Stop what you are doing" },
  { command: "help", description: "How it works" },
];

/** The "/" menu in groups. */
export const GROUP_COMMANDS: readonly BotCommandSpec[] = [
  { command: "buybot", description: "Buy alerts for this group" },
  { command: "coin", description: "Look up a coin by its address" },
  { command: "trending", description: "Top coins right now" },
  { command: "burns", description: "$MOATPAD buy & burn" },
  { command: "help", description: "How it works" },
];

/**
 * Every command `runCommand` answers, aliases included. In a group anything else is another bot's command
 * (/price for a price bot): it is ignored before it can use up the group's reply budget.
 */
export const COMMAND_NAMES: ReadonlySet<string> = new Set([
  "start",
  "help",
  "launch",
  "cancel",
  "coin",
  "trending",
  "burns",
  "burn",
  "buybot",
  "follow",
  "unfollow",
  "uncoin",
  "watch",
  "unwatch",
  "alerts",
  "list",
  "stop",
]);

export interface ParsedCommand {
  name: string;
  args: string[];
}

/**
 * "/watch@MoatpadBot  <addr>" → { name: "watch", args: ["<addr>"] }. Null when `text` is not a
 * command, or is addressed to another bot (`@OtherBot`) in a group.
 */
export function parseCommand(text: string, botUsername?: string | null): ParsedCommand | null {
  const match = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{1,64}))?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const [, name, target, rest] = match;
  if (target && botUsername && target.toLowerCase() !== botUsername.toLowerCase()) return null;
  return { name: name!.toLowerCase(), args: rest ? rest.trim().split(/\s+/).filter(Boolean) : [] };
}

export interface CommandContext {
  db: Queryable;
  links: BotLinks;
  now: () => number;
  api?: MoatpadApi;
  launch?: LaunchFlow;
  tg?: Pick<TelegramApi, "getChatMemberStatus">;
  maxSubscriptions?: number;
}

/** Who sent the command, and where (`threadId`: the forum topic of a topic supergroup). */
export interface CommandSource {
  chat: Pick<TgChat, "id" | "type">;
  from?: Pick<TgUser, "id">;
  threadId?: number;
}

const code = (s: string) => `<code>${escapeHtml(s)}</code>`;
const text = (html: string): BotReply => ({ html });

/** Telegram's account for "send as the group" (anonymous admins). */
const ANONYMOUS_ADMIN = 1087968824;

function limitText(max: number): string {
  return `This chat already has ${max} alerts, the most allowed. Remove one with /unfollow or /unwatch first.`;
}

/** Validates the single address argument; returns the address or the reply explaining what is wrong. */
function addressArg(cmd: ParsedCommand, what: "wallet" | "coin"): { address: string } | { reply: string } {
  const usage = `Usage: /${cmd.name} &lt;${what} address&gt;`;
  if (cmd.args.length < 1) return { reply: usage };
  const address = cmd.args[0]!;
  if (!isValidAddress(address)) return { reply: `${code(clip(address, 64))} is not a valid Solana address.\n${usage}` };
  return { address };
}

/** Watch a wallet: its payouts and weight milestones (`threadId`: the forum topic they go to). */
async function watch(ctx: CommandContext, chatId: number, wallet: string, threadId?: number): Promise<string> {
  const coin = await getCoin(ctx.db, wallet);
  if (coin) return `${code(shortAddress(wallet))} is the coin $${tickerText(coin)}, not a wallet. Get its alerts with /follow ${wallet}`;
  return subscribed(ctx, { chatId, threadId }, "wallet", wallet, () =>
    [
      `👀 Watching wallet ${code(wallet)}.`,
      "You will get a message for every payout it receives, and when one of its positions reaches 0.5x and full weight.",
      `Stop: ${code(`/unwatch ${wallet}`)}`,
    ].join("\n"),
  );
}

/** Follow a coin: payout rounds, floor defences, graduation (`threadId`: the forum topic they go to). */
export async function follow(ctx: CommandContext, chatId: number, mint: string, threadId?: number): Promise<string> {
  const coin = await getCoin(ctx.db, mint);
  if (!coin) return `No Moatpad coin has the address ${code(mint)}.`;
  return subscribed(ctx, { chatId, threadId }, "coin", coin.mint, () =>
    [
      `🔔 Alerts on for $${tickerText(coin)} (${escapeHtml(coin.name)}).`,
      "You will get every payout round, every floor defence and the graduation to PumpSwap.",
      `Turn off: ${code(`/unfollow ${coin.mint}`)}`,
      `<a href="${escapeHtml(coinUrl(ctx.links, coin.mint))}">Coin page</a>`,
    ].join("\n"),
  );
}

/** In a forum supergroup the alerts go to the topic the command was sent in; sent again from another topic, they move there. */
async function subscribed(
  ctx: CommandContext,
  where: { chatId: number; threadId?: number },
  kind: SubscriptionKind,
  target: string,
  added: () => string,
): Promise<string> {
  const max = ctx.maxSubscriptions ?? MAX_SUBSCRIPTIONS_PER_CHAT;
  const result = await addSubscription(ctx.db, { chatId: where.chatId, kind, target, atMs: ctx.now(), threadId: where.threadId ?? null }, { limit: max });
  if (result === "limit") return limitText(max);
  if (result === "exists") return kind === "wallet" ? `Already watching ${code(target)}.` : `Alerts are already on for ${code(target)}.`;
  if (result === "moved") return `${kind === "wallet" ? "Alerts for wallet" : "Alerts for"} ${code(target)} now go to ${where.threadId === undefined ? "the General topic" : "this topic"}.`;
  return added();
}

async function unfollow(ctx: CommandContext, chatId: number, cmd: ParsedCommand, kind: SubscriptionKind): Promise<string> {
  const arg = addressArg(cmd, kind === "wallet" ? "wallet" : "coin");
  if ("reply" in arg) return arg.reply;
  const removed = await removeSubscription(ctx.db, chatId, kind, arg.address);
  if (kind === "wallet") return removed ? `Stopped watching ${code(arg.address)}.` : `This chat was not watching ${code(arg.address)}.`;
  return removed ? `Alerts off for ${code(arg.address)}.` : `This chat had no alerts for ${code(arg.address)}.`;
}

async function alerts(ctx: CommandContext, chatId: number): Promise<string> {
  const subs = await listChatSubscriptions(ctx.db, chatId);
  const buybot = await getBuybot(ctx.db, chatId);
  if (subs.length === 0 && !buybot) return "No alerts yet. Try /follow &lt;coin address&gt; or /watch &lt;wallet&gt;.";
  const wallets = subs.filter((s) => s.kind === "wallet");
  const coinSubs = subs.filter((s) => s.kind === "coin");
  const coins = await getCoins(ctx.db, [...coinSubs.map((s) => s.target), ...(buybot ? [buybot.mint] : [])]);
  const lines = [`<b>This chat has ${subs.length} of ${ctx.maxSubscriptions ?? MAX_SUBSCRIPTIONS_PER_CHAT} alerts</b>`];
  if (buybot) {
    const c = coins.get(buybot.mint);
    lines.push("", `🟢 Buy bot: ${c ? `$${tickerText(c)}` : code(buybot.mint)}`);
  }
  if (wallets.length > 0) lines.push("", "Wallets:", ...wallets.map((s) => `• ${code(s.target)}`));
  if (coinSubs.length > 0) {
    lines.push("", "Coins:");
    for (const s of coinSubs) {
      const coin = coins.get(s.target);
      lines.push(coin ? `• $${tickerText(coin)} ${code(s.target)}` : `• ${code(s.target)}`);
    }
  }
  lines.push("", `<i>Turn off: /unfollow &lt;coin&gt;, /unwatch &lt;wallet&gt;${buybot ? ", /buybot off" : ""}, or /stop for all of them.</i>`);
  return lines.join("\n");
}

async function stop(ctx: CommandContext, chatId: number): Promise<string> {
  const n = await removeChatSubscriptions(ctx.db, chatId);
  const bot = await removeBuybot(ctx.db, chatId);
  const total = n + (bot ? 1 : 0);
  return total === 0 ? "Nothing to remove: this chat has no alerts." : `Removed ${total} ${total === 1 ? "alert" : "alerts"}. Send /start to begin again.`;
}

// Reads carry the Telegram user, so the API rate limits them per user (with INTERNAL_API_TOKEN), not per notifier IP.

async function coin(ctx: CommandContext, src: CommandSource, cmd: ParsedCommand): Promise<BotReply> {
  const arg = addressArg(cmd, "coin");
  if ("reply" in arg) return text(arg.reply);
  const detail = ctx.api ? await ctx.api.coin(arg.address, src.from?.id) : null;
  if (!detail) return text(`No Moatpad coin has the address ${code(arg.address)}.`);
  return coinCard(ctx.links, detail);
}

async function trending(ctx: CommandContext, src: CommandSource): Promise<BotReply> {
  if (!ctx.api) return text("Trending is not available right now.");
  return trendingMessage(ctx.links, await ctx.api.trending(5, src.from?.id));
}

async function burns(ctx: CommandContext, src: CommandSource): Promise<BotReply> {
  if (!ctx.api) return text("Burn stats are not available right now.");
  return burnsMessage(ctx.links, await ctx.api.burns(src.from?.id));
}

/** Whether the sender is an admin of the group (or posts as the group: anonymous admins). */
export async function isAdmin(ctx: CommandContext, src: CommandSource): Promise<boolean> {
  if (!src.from) return false;
  if (src.from.id === ANONYMOUS_ADMIN) return true;
  if (!ctx.tg) return false;
  const status = await ctx.tg.getChatMemberStatus(src.chat.id, src.from.id).catch(() => "left");
  return status === "creator" || status === "administrator";
}

/**
 * Changing a chat's alerts (/follow, /watch, /stop, /unfollow, /unwatch): anyone in a private chat; only
 * admins in a group, like the alerts button. Channel posts have no sender, and only channel admins can post there.
 */
async function mayChangeAlerts(ctx: CommandContext, src: CommandSource): Promise<boolean> {
  return src.chat.type === "private" || src.chat.type === "channel" || isAdmin(ctx, src);
}

const ADMINS_ONLY = "Only group admins can change this group's alerts.";

/** /buybot [<coin address> [min SOL] | off] — buy alerts in a group. */
export async function buybot(ctx: CommandContext, src: CommandSource, args: string[]): Promise<BotReply> {
  const addToGroup = botLink(ctx.links.botUsername, "buybot", true);
  if (src.chat.type === "private" || src.chat.type === "channel") {
    return {
      html: [
        "🟢 <b>Buy bot</b>",
        "",
        "Post every buy of your coin in your Telegram group, for free.",
        "",
        "1. Add me to your group (button below)",
        "2. In the group, send: <code>/buybot &lt;coin address&gt;</code>",
        "",
        "<i>Optional: only buys above an amount, e.g. /buybot &lt;address&gt; 0.5</i>",
      ].join("\n"),
      buttons: addToGroup ? [[{ text: "➕ Add to a group", url: addToGroup }]] : undefined,
    };
  }
  const current = await getBuybot(ctx.db, src.chat.id);
  if (args.length === 0) {
    if (!current) return text("Send <code>/buybot &lt;coin address&gt;</code> to post every buy of a Moatpad coin in this group.");
    const c = await getCoin(ctx.db, current.mint);
    const min = Number(current.minLamports) / 1e9;
    return text(`🟢 Buy alerts are on for ${c ? `$${tickerText(c)}` : code(current.mint)}${min > 0 ? ` (buys of ${min} SOL or more)` : ""}.\nSend /buybot off to stop.`);
  }
  if (!(await isAdmin(ctx, src))) return text("Only group admins can set up the buy bot.");
  if (args[0]!.toLowerCase() === "off") {
    return text((await removeBuybot(ctx.db, src.chat.id)) ? "Buy alerts are off for this group." : "Buy alerts were not on in this group.");
  }
  const mint = args[0]!;
  if (!isValidAddress(mint)) return text(`${code(clip(mint, 64))} is not a coin address.\nUsage: /buybot &lt;coin address&gt; [min SOL]`);
  const c = await getCoin(ctx.db, mint);
  if (!c) return text(`No Moatpad coin has the address ${code(mint)}. Only coins launched on Moatpad are supported.`);
  let minSol = 0;
  if (args[1] !== undefined) {
    minSol = Number(args[1].replace(",", "."));
    if (!Number.isFinite(minSol) || minSol < 0 || minSol > 1000) return text("The minimum must be a SOL amount, like 0.5.");
  }
  // In a forum supergroup the alerts go to the topic /buybot was sent in.
  await setBuybot(ctx.db, { chatId: src.chat.id, mint: c.mint, minLamports: BigInt(Math.round(minSol * 1e9)), createdBy: src.from?.id ?? null, atMs: ctx.now(), threadId: src.threadId ?? null });
  return {
    html: [
      `✅ <b>Buy bot on for $${tickerText(c)}</b>`,
      `${minSol > 0 ? `Every buy of ${minSol} SOL or more will be posted ` : "Every buy will be posted "}${src.threadId !== undefined ? "in this topic" : "here"}.`,
      "Floor defences (vault buybacks) are posted too. Send /buybot off to stop.",
    ].join("\n"),
    buttons: [[{ text: `🪙 $${c.ticker} on Moatpad`, url: coinUrl(ctx.links, c.mint) }]],
  };
}

/** /start with a deep-link payload: launch, coin_<mint>, follow_<mint>, watch_<wallet>, buybot[_<mint>]. */
async function start(ctx: CommandContext, src: CommandSource, payload: string | undefined): Promise<BotReply> {
  const [kind, value] = payload ? [payload.split("_")[0]!, payload.split("_").slice(1).join("_")] : ["", ""];
  if (kind === "buybot") return buybot(ctx, src, value ? [value] : []);
  if (src.chat.type !== "private") return { html: "Hi! I post buys, floor defences and payouts of Moatpad coins. Send /buybot to set me up here.", buttons: MENU };
  if (kind === "launch" && ctx.launch && src.from) return ctx.launch.start(src.chat.id, src.from.id);
  if (kind === "coin" && value) return coin(ctx, src, { name: "coin", args: [value] });
  if (kind === "follow" && value && isValidAddress(value)) return text(await follow(ctx, src.chat.id, value));
  if (kind === "watch" && value && isValidAddress(value)) return text(await watch(ctx, src.chat.id, value));
  return welcomeMessage(ctx.links);
}

/** Runs a parsed command; returns the reply, or null for an unknown command (one not in COMMAND_NAMES). */
export async function runCommand(ctx: CommandContext, src: CommandSource, cmd: ParsedCommand): Promise<BotReply | null> {
  if (!COMMAND_NAMES.has(cmd.name)) return null;
  const chatId = src.chat.id;
  const isPrivate = src.chat.type === "private";
  switch (cmd.name) {
    case "start":
      return start(ctx, src, cmd.args[0]);
    case "help":
      return helpMessage(ctx.links);
    case "launch": {
      if (!isPrivate || !ctx.launch || !src.from) {
        const link = botLink(ctx.links.botUsername, "launch");
        return { html: "Launching works in a private chat with me.", buttons: link ? [[{ text: "🚀 Launch in private chat", url: link }]] : undefined };
      }
      return ctx.launch.start(chatId, src.from.id);
    }
    case "cancel":
      return ctx.launch ? ctx.launch.cancel(chatId) : text("Nothing to cancel.");
    case "coin":
      return coin(ctx, src, cmd);
    case "trending":
      return trending(ctx, src);
    case "burns":
    case "burn":
      return burns(ctx, src);
    case "buybot":
      return buybot(ctx, src, cmd.args);
    case "follow": {
      if (!(await mayChangeAlerts(ctx, src))) return text(ADMINS_ONLY);
      const arg = addressArg(cmd, "coin");
      return text("reply" in arg ? arg.reply : await follow(ctx, chatId, arg.address, src.threadId));
    }
    case "unfollow":
    case "uncoin":
      if (!(await mayChangeAlerts(ctx, src))) return text(ADMINS_ONLY);
      return text(await unfollow(ctx, chatId, cmd, "coin"));
    case "watch": {
      if (!(await mayChangeAlerts(ctx, src))) return text(ADMINS_ONLY);
      const arg = addressArg(cmd, "wallet");
      return text("reply" in arg ? arg.reply : await watch(ctx, chatId, arg.address, src.threadId));
    }
    case "unwatch":
      if (!(await mayChangeAlerts(ctx, src))) return text(ADMINS_ONLY);
      return text(await unfollow(ctx, chatId, cmd, "wallet"));
    case "alerts":
    case "list":
      return text(await alerts(ctx, chatId));
    case "stop":
      // In a group /stop also turns off the buy bot: admins only, like /buybot off.
      if (!(await mayChangeAlerts(ctx, src))) return text(ADMINS_ONLY);
      return text(await stop(ctx, chatId));
    default:
      return null;
  }
}

export interface TextResult {
  /** Metric label: the command name, "unknown" or "text". */
  command: string;
  reply: BotReply;
}

/**
 * One incoming text message that is not part of a launch. Commands run; anything else gets the menu in
 * a private chat and is ignored in groups and channels (where the bot sees other people's messages too).
 */
export async function handleText(ctx: CommandContext, src: CommandSource, message: string, botUsername?: string | null): Promise<TextResult | null> {
  const cmd = parseCommand(message, botUsername);
  const isPrivate = src.chat.type === "private";
  if (!cmd) return isPrivate ? { command: "text", reply: { html: "Hi! What do you want to do? Send /help to see every command.", buttons: MENU } } : null;
  const reply = await runCommand(ctx, src, cmd);
  if (reply !== null) return { command: cmd.name, reply };
  return isPrivate ? { command: "unknown", reply: { html: `Unknown command /${escapeHtml(cmd.name)}. Send /help for the list.` } } : null;
}
