import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BurnStats, CoinDetail, CoinSummary } from "@holdfast/core";
import { countChatSubscriptions, getBuybot, listChatSubscriptions, type Db } from "@holdfast/db";

import type { MoatpadApi } from "../src/api.js";
import { GROUP_COMMANDS, handleText, isValidAddress, MAX_SUBSCRIPTIONS_PER_CHAT, parseCommand, PRIVATE_COMMANDS, runCommand, type CommandContext } from "../src/commands.js";
import type { BotReply } from "../src/messages.js";
import { addr, FakeTelegram, freshDb, LINKS, NOW, resetDb, seedCoin } from "./helpers.js";

let db: Db;
let ctx: CommandContext;
let tg: FakeTelegram;

/** Serves coin cards for the coins in `coins`, a trending list and burn stats. */
class FakeApi implements MoatpadApi {
  coins = new Map<string, CoinDetail>();
  burnStats: BurnStats = { burns: 0, solSpent: 0, tokensBurned: 0, lastAt: null, recent: [] };
  async quote() {
    return { launchFeeSol: 0.015, devBuySol: 0, devBuyExtraSol: 0, requiredSol: 0.015, requiredLamports: "15000000", specFeeSol: 0.015, exceedsSpecFee: false };
  }
  async createLaunch(): Promise<never> {
    throw new Error("not used");
  }
  async uploadImage(): Promise<string> {
    return "https://img.example/x.png";
  }
  async coin(mint: string) {
    return this.coins.get(mint) ?? null;
  }
  async trending(limit: number): Promise<CoinSummary[]> {
    return [...this.coins.values()].slice(0, limit);
  }
  async burns() {
    return this.burnStats;
  }
}
let api: FakeApi;

function detail(mint: string, overrides: Partial<CoinDetail> = {}): CoinDetail {
  return {
    mint,
    name: "Hound",
    ticker: "HOUND",
    imageUrl: null,
    createdAt: NOW,
    triggerBps: 2500,
    price: 1e-7,
    marketCapSol: 52.31,
    athMarketCapSol: 60,
    floorMarketCapSol: 45,
    floorToAthProgress: 0.5,
    vaultBuying: false,
    change24hPct: 12.5,
    volume24hSol: 80,
    holders: 120,
    paidOutSol: 3.2,
    graduated: false,
    bondingCurveProgress: 0.42,
    vault: { floorSol: 4.5 } as CoinDetail["vault"],
    description: "",
    socials: {},
    launcher: null,
    vaultAddress: addr("v"),
    treasuryAddress: addr("t"),
    bondingCurve: addr("c"),
    ammPool: null,
    roundId: 1,
    lastRound: null,
    hidden: false,
    hiddenReason: null,
    ...overrides,
  };
}

beforeAll(async () => {
  db = await freshDb();
});
beforeEach(async () => {
  await resetDb(db);
  tg = new FakeTelegram();
  api = new FakeApi();
  ctx = { db, links: LINKS, now: () => NOW, api, tg };
});
afterAll(async () => {
  await db.close();
});

const PRIVATE = { id: 42, type: "private" as const };
const GROUP = { id: -100500, type: "supergroup" as const };
type Chat = { id: number; type: "private" | "group" | "supergroup" | "channel" };

async function sayReply(text: string, chat: Chat = PRIVATE, fromId = 7): Promise<BotReply> {
  const res = await handleText(ctx, { chat, from: { id: fromId } }, text, "HoldfastBot");
  if (!res) throw new Error(`no reply to ${text}`);
  return res.reply;
}
const say = async (text: string, chat: Chat = PRIVATE, fromId = 7) => (await sayReply(text, chat, fromId)).html;
const buttons = (r: BotReply) => (r.buttons ?? []).flat().map((b) => b.callback_data ?? b.url);

describe("parseCommand", () => {
  it("splits the command name and arguments", () => {
    expect(parseCommand("/watch abc")).toEqual({ name: "watch", args: ["abc"] });
    expect(parseCommand("  /WATCH@HoldfastBot   abc  def ", "holdfastbot")).toEqual({ name: "watch", args: ["abc", "def"] });
    expect(parseCommand("/list")).toEqual({ name: "list", args: [] });
    expect(parseCommand("/coin\nabc")).toEqual({ name: "coin", args: ["abc"] });
  });

  it("ignores plain text and commands for other bots", () => {
    expect(parseCommand("hello /watch")).toBeNull();
    expect(parseCommand("/")).toBeNull();
    expect(parseCommand("/watch@OtherBot abc", "HoldfastBot")).toBeNull();
    expect(parseCommand("/watch@OtherBot abc")).toEqual({ name: "watch", args: ["abc"] });
  });
});

describe("isValidAddress", () => {
  it("accepts 32-byte base58 addresses only", () => {
    expect(isValidAddress(addr("alice"))).toBe(true);
    expect(isValidAddress("11111111111111111111111111111111")).toBe(true);
    expect(isValidAddress("abc")).toBe(false);
    expect(isValidAddress(`${addr("alice").slice(0, -1)}0`)).toBe(false);
    expect(isValidAddress("z".repeat(44))).toBe(false);
  });
});

describe("menus, /start and /help", () => {
  it("has short English command menus for private chats and groups", () => {
    expect(PRIVATE_COMMANDS.map((c) => c.command)).toEqual(["launch", "coin", "trending", "burns", "buybot", "follow", "watch", "alerts", "cancel", "help"]);
    expect(GROUP_COMMANDS.map((c) => c.command)).toEqual(["buybot", "coin", "trending", "burns", "help"]);
    for (const c of [...PRIVATE_COMMANDS, ...GROUP_COMMANDS]) expect(c.description.length).toBeLessThanOrEqual(40);
  });

  it("/start greets with the menu buttons and /help lists every command", async () => {
    const start = await sayReply("/start");
    expect(start.html).toContain("Welcome to Moatpad");
    expect(buttons(start)).toEqual(["m:launch", "m:trending", "m:burns", "m:help", LINKS.webUrl]);
    const help = await say("/help");
    for (const c of ["/launch", "/coin", "/trending", "/burns", "/buybot", "/follow", "/watch", "/alerts", "/cancel"]) expect(help).toContain(c);
    expect(help).toContain("every 2 minutes");
    expect(help).toContain("10% buys and burns $MOATPAD");
  });

  it("deep links: coin_, follow_ and watch_ payloads", async () => {
    const coin = await seedCoin(db, "hound");
    api.coins.set(coin.mint, detail(coin.mint));
    expect(await say(`/start coin_${coin.mint}`)).toContain("Market cap: <b>52.31 SOL</b>");
    expect(await say(`/start follow_${coin.mint}`)).toContain("🔔 Alerts on for $HOUND");
    expect(await say(`/start watch_${addr("alice")}`)).toContain("Watching wallet");
    expect(await countChatSubscriptions(db, PRIVATE.id)).toBe(2);
  });

  it("/launch in a group points to the private chat", async () => {
    const r = await sayReply("/launch", GROUP);
    expect(r.html).toBe("Launching works in a private chat with me.");
    expect(buttons(r)).toEqual(["https://t.me/HoldfastBot?start=launch"]);
  });
});

describe("/coin, /trending and /burns", () => {
  it("/coin shows the card with buy, alerts and buy-bot buttons", async () => {
    const coin = await seedCoin(db, "hound");
    api.coins.set(coin.mint, detail(coin.mint, { name: "Hound & <Friends>", vaultBuying: true }));
    const r = await sayReply(`/coin ${coin.mint}`);
    expect(r.html).toContain("<b>Hound &amp; &lt;Friends&gt;</b> ($HOUND)");
    expect(r.html).toContain("(+12.5% 24h)");
    expect(r.html).toContain("buying back now");
    expect(r.html).toContain("Bonding curve: 42%");
    expect(buttons(r)).toEqual([`${LINKS.webUrl}/coin/${coin.mint}`, `f:${coin.mint}`, `https://t.me/HoldfastBot?startgroup=buybot_${coin.mint}`]);
    expect(await say(`/coin ${addr("nope")}`)).toBe(`No Moatpad coin has the address <code>${addr("nope")}</code>.`);
    expect(await say("/coin")).toBe("Usage: /coin &lt;coin address&gt;");
  });

  it("/trending lists the top coins and /burns shows the burn stats", async () => {
    expect(await say("/trending")).toContain("No coins yet");
    api.coins.set(addr("a"), detail(addr("a")));
    api.coins.set(addr("b"), detail(addr("b"), { ticker: "BEE", change24hPct: -3 }));
    const t = await say("/trending");
    expect(t).toContain("1. <a");
    expect(t).toContain("<b>$BEE</b></a> · MC 52.31 SOL · -3.0%");

    expect(await say("/burns")).toContain("No burn has happened yet");
    api.burnStats = { burns: 2, solSpent: 0.15, tokensBurned: 3_500_000, lastAt: NOW, recent: [{ sig: "S1", mint: addr("a"), ticker: "HOUND", solSpent: 0.1, tokensBurned: 2_500_000, ts: NOW }] };
    const b = await sayReply("/burns");
    expect(b.html).toContain("Burned: <b>3.5M $MOATPAD</b>");
    expect(b.html).toContain("Spent: 0.15 SOL in 2 burns");
    expect(b.html).toContain("2.5M $MOATPAD by the $HOUND vault");
    expect(buttons(b)).toEqual([`https://pump.fun/coin/${LINKS.moatCa}`]);
  });
});

describe("/buybot", () => {
  it("explains itself in a private chat with an add-to-group button", async () => {
    const r = await sayReply("/buybot");
    expect(r.html).toContain("Add me to your group");
    expect(buttons(r)).toEqual(["https://t.me/HoldfastBot?startgroup=buybot"]);
  });

  it("only group admins turn it on, for Moatpad coins, with an optional minimum", async () => {
    const coin = await seedCoin(db, "hound");
    expect(await say(`/buybot ${coin.mint}`, GROUP, 9)).toBe("Only group admins can set up the buy bot.");
    tg.members.set(`${GROUP.id}:9`, "administrator");
    expect(await say(`/buybot ${addr("nope")}`, GROUP, 9)).toContain("Only coins launched on Moatpad are supported.");
    expect(await say(`/buybot ${coin.mint} abc`, GROUP, 9)).toBe("The minimum must be a SOL amount, like 0.5.");
    expect(await say(`/buybot ${coin.mint} 0.5`, GROUP, 9)).toContain("Every buy of 0.5 SOL or more will be posted here.");
    expect(await getBuybot(db, GROUP.id)).toMatchObject({ mint: coin.mint, minLamports: 500_000_000n });
    expect(await say("/buybot", GROUP, 3)).toBe("🟢 Buy alerts are on for $HOUND (buys of 0.5 SOL or more).\nSend /buybot off to stop.");
    expect(await say("/buybot off", GROUP, 3)).toBe("Only group admins can set up the buy bot.");
    expect(await say("/buybot off", GROUP, 9)).toBe("Buy alerts are off for this group.");
    expect(await getBuybot(db, GROUP.id)).toBeNull();
  });

  it("turns on from the add-to-group deep link (/start buybot_<mint>) and for anonymous admins", async () => {
    const coin = await seedCoin(db, "hound");
    tg.members.set(`${GROUP.id}:9`, "creator");
    expect(await say(`/start buybot_${coin.mint}`, GROUP, 9)).toContain("Buy bot on for $HOUND");
    await say("/buybot off", GROUP, 9);
    expect(await say(`/buybot ${coin.mint}`, GROUP, 1087968824)).toContain("Buy bot on for $HOUND");
  });
});

describe("/watch, /follow and the alert list", () => {
  it("validates, subscribes once and unsubscribes", async () => {
    const wallet = addr("alice");
    expect(await say("/watch")).toBe("Usage: /watch &lt;wallet address&gt;");
    expect(await say("/watch <script>")).toBe("<code>&lt;script&gt;</code> is not a valid Solana address.\nUsage: /watch &lt;wallet address&gt;");
    expect(await say(`/watch ${wallet}`)).toContain(`👀 Watching wallet <code>${wallet}</code>.`);
    expect(await say(`/watch ${wallet}`)).toBe(`Already watching <code>${wallet}</code>.`);
    expect(await listChatSubscriptions(db, PRIVATE.id)).toEqual([{ chatId: 42, kind: "wallet", target: wallet, createdAt: NOW }]);
    expect(await say(`/unwatch ${wallet}`)).toBe(`Stopped watching <code>${wallet}</code>.`);
    expect(await countChatSubscriptions(db, PRIVATE.id)).toBe(0);
  });

  it("points a coin address to /follow", async () => {
    const coin = await seedCoin(db, "hound");
    expect(await say(`/watch ${coin.mint}`)).toContain(`is the coin $HOUND, not a wallet. Get its alerts with /follow ${coin.mint}`);
  });

  it("follows a coin, with /uncoin kept as an alias of /unfollow", async () => {
    const coin = await seedCoin(db, "hound", { name: "Hound & <Friends>" });
    expect(await say(`/follow ${addr("nope")}`)).toBe(`No Moatpad coin has the address <code>${addr("nope")}</code>.`);
    const reply = await say(`/follow ${coin.mint}`);
    expect(reply).toContain("🔔 Alerts on for $HOUND (Hound &amp; &lt;Friends&gt;).");
    expect(await say(`/follow ${coin.mint}`)).toBe(`Alerts are already on for <code>${coin.mint}</code>.`);
    expect(await say(`/uncoin ${coin.mint}`)).toBe(`Alerts off for <code>${coin.mint}</code>.`);
    expect(await say(`/unfollow ${coin.mint}`)).toBe(`This chat had no alerts for <code>${coin.mint}</code>.`);
  });

  it(`stops at ${MAX_SUBSCRIPTIONS_PER_CHAT} alerts per chat`, async () => {
    for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_CHAT; i++) await say(`/watch ${addr(`w${i}`)}`);
    expect(await say(`/watch ${addr("one-too-many")}`)).toBe("This chat already has 20 alerts, the most allowed. Remove one with /unfollow or /unwatch first.");
  });

  it("/alerts lists the buy bot, wallets and coins; /stop removes everything for the chat only", async () => {
    expect(await say("/alerts")).toBe("No alerts yet. Try /follow &lt;coin address&gt; or /watch &lt;wallet&gt;.");
    const coin = await seedCoin(db, "hound");
    const [a, b] = [addr("alice"), addr("bob")];
    await say(`/watch ${a}`);
    await say(`/follow ${coin.mint}`);
    await say(`/watch ${b}`);
    await say(`/watch ${a}`, { id: 7, type: "private" });
    expect(await say("/list")).toBe(
      ["<b>This chat has 3 of 20 alerts</b>", "", "Wallets:", `• <code>${a}</code>`, `• <code>${b}</code>`, "", "Coins:", `• $HOUND <code>${coin.mint}</code>`].join("\n"),
    );
    expect(await say("/stop")).toBe("Removed 3 alerts. Send /start to begin again.");
    expect(await say("/stop")).toBe("Nothing to remove: this chat has no alerts.");
    expect(await countChatSubscriptions(db, 7)).toBe(1);
  });
});

describe("handleText", () => {
  it("answers anything in a private chat with the menu, only known commands in groups", async () => {
    const gm = await handleText(ctx, { chat: PRIVATE }, "gm", "HoldfastBot");
    expect(gm?.command).toBe("text");
    expect(gm?.reply.buttons?.flat().map((b) => b.callback_data)).toContain("m:launch");
    expect((await handleText(ctx, { chat: PRIVATE }, "/dance", "HoldfastBot"))?.reply.html).toBe("Unknown command /dance. Send /help for the list.");
    expect(await handleText(ctx, { chat: GROUP }, "gm", "HoldfastBot")).toBeNull();
    expect(await handleText(ctx, { chat: GROUP }, "/dance", "HoldfastBot")).toBeNull();
    expect(await handleText(ctx, { chat: GROUP }, `/watch@OtherBot ${addr("alice")}`, "HoldfastBot")).toBeNull();
    expect((await handleText(ctx, { chat: GROUP }, `/watch@HoldfastBot ${addr("alice")}`, "HoldfastBot"))?.command).toBe("watch");
    expect(await runCommand(ctx, { chat: PRIVATE }, { name: "dance", args: [] })).toBeNull();
  });
});
