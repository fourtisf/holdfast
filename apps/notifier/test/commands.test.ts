import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { countChatSubscriptions, listChatSubscriptions, type Db } from "@holdfast/db";

import { handleText, helpText, isValidAddress, MAX_SUBSCRIPTIONS_PER_CHAT, parseCommand, runCommand, type CommandContext } from "../src/commands.js";
import { addr, freshDb, LINKS, NOW, resetDb, seedCoin } from "./helpers.js";

let db: Db;
let ctx: CommandContext;
beforeAll(async () => {
  db = await freshDb();
  ctx = { db, links: LINKS, now: () => NOW };
});
beforeEach(async () => {
  await resetDb(db);
});
afterAll(async () => {
  await db.close();
});

const PRIVATE = { id: 42, type: "private" as const };
const GROUP = { id: -100500, type: "supergroup" as const };

async function say(text: string, chat: { id: number; type: "private" | "group" | "supergroup" | "channel" } = PRIVATE): Promise<string> {
  const res = await handleText(ctx, chat, text, "HoldfastBot");
  if (!res) throw new Error(`no reply to ${text}`);
  return res.reply;
}

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
    // Without a known username every addressed command is accepted.
    expect(parseCommand("/watch@OtherBot abc")).toEqual({ name: "watch", args: ["abc"] });
  });
});

describe("isValidAddress", () => {
  it("accepts 32-byte base58 addresses only", () => {
    expect(isValidAddress(addr("alice"))).toBe(true);
    expect(isValidAddress("11111111111111111111111111111111")).toBe(true); // system program
    expect(isValidAddress("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")).toBe(true);
    expect(isValidAddress("abc")).toBe(false);
    expect(isValidAddress(`${addr("alice").slice(0, -1)}0`)).toBe(false); // 0 is not base58
    expect(isValidAddress("O".repeat(40))).toBe(false);
    expect(isValidAddress("z".repeat(44))).toBe(false); // decodes to more than 32 bytes
    expect(isValidAddress("2".repeat(45))).toBe(false);
  });
});

describe("/start and /help", () => {
  it("explains the bot and lists every command", async () => {
    const help = await say("/start");
    expect(help).toBe(helpText());
    expect(await say("/help")).toBe(help);
    for (const c of ["/watch", "/unwatch", "/coin", "/uncoin", "/list", "/stop", "/help"]) expect(help).toContain(c);
    expect(help).toContain("floor vault");
    expect(help).toContain("every 2 minutes");
    expect(help).toContain("&lt;wallet&gt;");
  });
});

describe("/watch and /unwatch", () => {
  it("validates, subscribes once and unsubscribes", async () => {
    const wallet = addr("alice");
    expect(await say("/watch")).toBe("Usage: /watch &lt;wallet address&gt;");
    expect(await say("/watch <script>")).toBe("<code>&lt;script&gt;</code> is not a valid Solana address.\nUsage: /watch &lt;wallet address&gt;");
    expect(await say(`/watch ${wallet}`)).toContain(`👀 Watching wallet <code>${wallet}</code>.`);
    expect(await say(`/watch ${wallet}`)).toBe(`Already watching <code>${wallet}</code>.`);
    expect(await listChatSubscriptions(db, PRIVATE.id)).toEqual([{ chatId: 42, kind: "wallet", target: wallet, createdAt: NOW }]);

    expect(await say(`/unwatch ${wallet}`)).toBe(`Stopped watching <code>${wallet}</code>.`);
    expect(await say(`/unwatch ${wallet}`)).toBe(`This chat was not watching <code>${wallet}</code>.`);
    expect(await countChatSubscriptions(db, PRIVATE.id)).toBe(0);
  });

  it("points a coin mint to /coin", async () => {
    const coin = await seedCoin(db, "hound");
    expect(await say(`/watch ${coin.mint}`)).toContain(`is the mint of $HOUND, not a wallet. Follow the coin with /coin ${coin.mint}`);
    expect(await countChatSubscriptions(db, PRIVATE.id)).toBe(0);
  });

  it(`stops at ${MAX_SUBSCRIPTIONS_PER_CHAT} subscriptions per chat`, async () => {
    const coin = await seedCoin(db, "hound");
    for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_CHAT - 1; i++) expect(await say(`/watch ${addr(`w${i}`)}`)).toContain("Watching");
    expect(await say(`/coin ${coin.mint}`)).toContain("Following $HOUND");
    expect(await countChatSubscriptions(db, PRIVATE.id)).toBe(MAX_SUBSCRIPTIONS_PER_CHAT);

    expect(await say(`/watch ${addr("one-too-many")}`)).toBe(
      "This chat already has 20 subscriptions, the most allowed. Remove one with /unwatch or /uncoin first.",
    );
    expect(await countChatSubscriptions(db, PRIVATE.id)).toBe(MAX_SUBSCRIPTIONS_PER_CHAT);
    // Re-watching an existing one is not blocked by the limit, and other chats have their own.
    expect(await say(`/watch ${addr("w0")}`)).toContain("Already watching");
    expect(await say(`/watch ${addr("one-too-many")}`, { id: 7, type: "private" })).toContain("Watching");
    // Removing one makes room again.
    await say(`/unwatch ${addr("w0")}`);
    expect(await say(`/watch ${addr("one-too-many")}`)).toContain("Watching");
  });
});

describe("/coin and /uncoin", () => {
  it("requires the coin to exist", async () => {
    const unknown = addr("nope");
    expect(await say(`/coin ${unknown}`)).toBe(`No Moatpad coin has the mint <code>${unknown}</code>.`);
    expect(await say("/coin not-an-address")).toContain("is not a valid Solana address");
    expect(await countChatSubscriptions(db, PRIVATE.id)).toBe(0);

    const coin = await seedCoin(db, "hound", { name: "Hound & <Friends>" });
    const reply = await say(`/coin ${coin.mint}`);
    expect(reply).toContain("🔔 Following $HOUND (Hound &amp; &lt;Friends&gt;).");
    expect(reply).toContain(`<a href="https://holdfast.example/coin/${coin.mint}">Coin page</a>`);
    expect(await say(`/coin ${coin.mint}`)).toBe(`Already following <code>${coin.mint}</code>.`);
    expect(await say(`/uncoin ${coin.mint}`)).toBe(`Unfollowed <code>${coin.mint}</code>.`);
    expect(await say(`/uncoin ${coin.mint}`)).toBe(`This chat was not following <code>${coin.mint}</code>.`);
  });
});

describe("/list and /stop", () => {
  it("lists wallets and coins, and /stop removes everything for the chat only", async () => {
    expect(await say("/list")).toBe("This chat follows nothing yet. Try /watch &lt;wallet&gt; or /coin &lt;mint&gt;.");
    const coin = await seedCoin(db, "hound");
    const [a, b] = [addr("alice"), addr("bob")];
    await say(`/watch ${a}`);
    await say(`/coin ${coin.mint}`);
    await say(`/watch ${b}`);
    await say(`/watch ${a}`, { id: 7, type: "private" });

    expect(await say("/list")).toBe(
      ["<b>This chat follows 3 of 20</b>", "", "Wallets:", `• <code>${a}</code>`, `• <code>${b}</code>`, "", "Coins:", `• $HOUND <code>${coin.mint}</code>`].join("\n"),
    );
    expect(await say("/stop")).toBe("Removed 3 subscriptions. Send /start to begin again.");
    expect(await say("/stop")).toBe("Nothing to remove: this chat follows nothing.");
    expect(await countChatSubscriptions(db, 7)).toBe(1);
  });
});

describe("handleText", () => {
  it("answers anything in a private chat, only known commands in groups", async () => {
    expect(await handleText(ctx, PRIVATE, "gm", "HoldfastBot")).toEqual({ command: "text", reply: "Send /help to see what this bot can do." });
    expect(await handleText(ctx, PRIVATE, "/dance", "HoldfastBot")).toEqual({ command: "unknown", reply: "Unknown command /dance. Send /help for the list." });
    expect(await handleText(ctx, GROUP, "gm", "HoldfastBot")).toBeNull();
    expect(await handleText(ctx, GROUP, "/dance", "HoldfastBot")).toBeNull();
    expect(await handleText(ctx, GROUP, `/watch@OtherBot ${addr("alice")}`, "HoldfastBot")).toBeNull();
    expect((await handleText(ctx, GROUP, `/watch@HoldfastBot ${addr("alice")}`, "HoldfastBot"))?.command).toBe("watch");
    expect(await countChatSubscriptions(db, GROUP.id)).toBe(1);
    expect(await runCommand(ctx, 1, { name: "dance", args: [] })).toBeNull();
  });
});
