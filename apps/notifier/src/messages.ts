/** Bot message texts (Telegram HTML). Every user-supplied string goes through escapeHtml. */
import type { BurnStats, CoinDetail, CoinSummary, LaunchStatusKind } from "@holdfast/core";
import {
  botLink,
  coinUrl,
  formatCompact,
  formatMultiplier,
  formatPrice,
  formatSol,
  formatSolNumber,
  formatTokens,
  shortAddress,
  solscanAccountUrl,
  solscanTxUrl,
  type Links,
} from "./format.js";
import { escapeHtml, type Keyboard } from "./telegram.js";

export interface CoinLabel {
  mint: string;
  ticker: string;
  decimals: number;
}

/** "HOUND", or the short mint while the coin has no ticker yet. Escaped. */
export function tickerText(coin: CoinLabel): string {
  return escapeHtml(coin.ticker.trim() || shortAddress(coin.mint));
}

function link(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

function coinLink(links: Links, coin: CoinLabel): string {
  return link(coinUrl(links, coin.mint), `$${coin.ticker.trim() || shortAddress(coin.mint)} on Moatpad`);
}

function linksLine(links: Links, coin: CoinLabel, sig: string | null): string {
  const parts = [coinLink(links, coin)];
  if (sig) parts.push(link(solscanTxUrl(sig, links.cluster), "Solscan"));
  return parts.join(" · ");
}

function tokensPart(tokens: bigint, coin: CoinLabel): string {
  return tokens > 0n ? ` (+ ${formatTokens(tokens, coin.decimals)} ${tickerText(coin)})` : "";
}

export function walletLine(wallet: string): string {
  return `Wallet <code>${escapeHtml(shortAddress(wallet))}</code>`;
}

/** To a chat watching `wallet`: what it got from one closed round. */
export function payoutMessage(links: Links, p: { coin: CoinLabel; roundId: number | bigint; wallet: string; sol: bigint; tokens: bigint; sig: string | null }): string {
  return [
    `💰 You earned ${formatSol(p.sol)} SOL${tokensPart(p.tokens, p.coin)} from $${tickerText(p.coin)} round #${p.roundId}`,
    walletLine(p.wallet),
    linksLine(links, p.coin, p.sig),
  ].join("\n");
}

/** To a chat following the coin: the round's totals. */
export function roundSummaryMessage(links: Links, r: { coin: CoinLabel; roundId: number | bigint; sol: bigint; tokens: bigint; holders: number; closeSig: string | null }): string {
  return [
    `Round #${r.roundId} of $${tickerText(r.coin)} paid ${formatSol(r.sol)} SOL${tokensPart(r.tokens, r.coin)} to ${r.holders} ${r.holders === 1 ? "holder" : "holders"}`,
    linksLine(links, r.coin, r.closeSig),
  ].join("\n");
}

/** A floor-defence buyback (vault trade). `floorPrice` is the vault's floor in SOL per token, when known. */
export function defendMessage(links: Links, d: { coin: CoinLabel; sol: bigint; price: number; floorPrice: number | null; sig: string }): string {
  const lines = [`🛡 Floor defended: the $${tickerText(d.coin)} vault bought back ${formatSol(d.sol)} SOL at price ${formatPrice(d.price)} SOL`];
  if (d.floorPrice !== null && d.floorPrice > 0) lines.push(`Floor: ${formatPrice(d.floorPrice)} SOL per token`);
  lines.push(linksLine(links, d.coin, d.sig));
  return lines.join("\n");
}

export function graduatedMessage(links: Links, coin: CoinLabel): string {
  return [`🎓 $${tickerText(coin)} graduated to PumpSwap`, coinLink(links, coin)].join("\n");
}

export type Milestone = "0.5" | "1.0";

/** A watched wallet's position in a coin reached a weight milestone. `multiplierPpm` is its current average weight. */
export function milestoneMessage(links: Links, m: { coin: CoinLabel; wallet: string; milestone: Milestone; multiplierPpm: bigint }): string {
  const head =
    m.milestone === "1.0"
      ? `🏆 Your $${tickerText(m.coin)} position reached full weight (1.0x): it now earns its full share of every payout`
      : `⚖️ Your $${tickerText(m.coin)} position reached 0.5x weight (now ${formatMultiplier(m.multiplierPpm)}); it keeps rising to 1.0x over 7 days of holding`;
  return [head, walletLine(m.wallet), coinLink(links, m.coin)].join("\n");
}

// ---- the launchpad bot: menu, help, cards, buy alerts, launch progress, burns -------------------------------


export interface BotReply {
  html: string;
  buttons?: Keyboard;
  preview?: boolean;
}

/** A coin card, the trending list... need the bot's username for its deep links. */
export interface BotLinks extends Links {
  botUsername: string | null;
  /** The official $MOATPAD mint (pump.fun). */
  moatCa: string;
}

export const MENU: Keyboard = [
  [
    { text: "🚀 Launch a coin", callback_data: "m:launch" },
    { text: "📈 Trending", callback_data: "m:trending" },
  ],
  [
    { text: "🔥 $MOATPAD burns", callback_data: "m:burns" },
    { text: "❓ How it works", callback_data: "m:help" },
  ],
];

export function welcomeMessage(links: BotLinks): BotReply {
  return {
    html: [
      "👋 <b>Welcome to Moatpad</b>",
      "",
      "Launch a coin on pump.fun in 2 minutes. Every Moatpad coin has its own vault that <b>defends the floor</b> and <b>pays holders every 2 minutes</b>.",
      "",
      "What do you want to do?",
    ].join("\n"),
    buttons: [...MENU, [{ text: "🌐 Open moatpad.fun", url: links.webUrl }]],
  };
}

export function helpMessage(links: BotLinks): BotReply {
  return {
    html: [
      "<b>Moatpad Bot</b>",
      "",
      "🚀 /launch - launch a new coin",
      "🔎 /coin &lt;address&gt; - look up a coin",
      "📈 /trending - top coins right now",
      "🔥 /burns - $MOATPAD buy &amp; burn",
      "🟢 /buybot - buy alerts for your group",
      "🔔 /follow &lt;address&gt; - alerts for a coin",
      "👛 /watch &lt;wallet&gt; - payout alerts for your wallet",
      "📋 /alerts - what this chat follows",
      "✖️ /cancel - stop what you are doing",
      "",
      "<b>How Moatpad works</b>",
      "Every trade pays a fee into the coin's own vault:",
      "• 40% defends the floor (automatic buybacks)",
      "• 25% is paid to holders every 2 minutes",
      "• 15% goes to the creator",
      "• 10% Moatpad treasury",
      "• 10% buys and burns $MOATPAD",
    ].join("\n"),
    buttons: [[{ text: "🚀 Launch a coin", callback_data: "m:launch" }, { text: "🌐 moatpad.fun", url: links.webUrl }]],
  };
}

function pct(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

/** /coin: the coin's numbers and what to do next. */
export function coinCard(links: BotLinks, c: CoinDetail): BotReply {
  const url = coinUrl(links, c.mint);
  const lines = [
    `🪙 <b>${escapeHtml(c.name)}</b> ($${escapeHtml(c.ticker)})`,
    `<code>${escapeHtml(c.mint)}</code>`,
    "",
    `📊 Market cap: <b>${formatSolNumber(c.marketCapSol)} SOL</b> (${pct(c.change24hPct)} 24h)`,
    `💧 Volume 24h: ${formatSolNumber(c.volume24hSol)} SOL`,
    `👥 Holders: ${c.holders.toLocaleString("en-US")}`,
    `🛡 Floor vault: ${formatSolNumber(c.vault.floorSol)} SOL${c.vaultBuying ? " · <b>buying back now</b>" : ""}`,
    `💰 Paid to holders: ${formatSolNumber(c.paidOutSol)} SOL`,
    c.graduated ? "🎓 Graduated to PumpSwap" : `📈 Bonding curve: ${Math.round(c.bondingCurveProgress * 100)}%`,
  ];
  const buttons: Keyboard = [[{ text: `🟢 Buy $${c.ticker} on Moatpad`, url }], [{ text: "🔔 Get alerts", callback_data: `f:${c.mint}` }]];
  const group = botLink(links.botUsername, `buybot_${c.mint}`, true);
  if (group) buttons[1]!.push({ text: "➕ Buy bot for your group", url: group });
  return { html: lines.join("\n"), buttons };
}

export function trendingMessage(links: BotLinks, coins: readonly CoinSummary[]): BotReply {
  if (coins.length === 0) return { html: "No coins yet. Be the first: /launch", buttons: [[{ text: "🚀 Launch a coin", callback_data: "m:launch" }]] };
  const lines = ["📈 <b>Trending on Moatpad</b>", ""];
  coins.forEach((c, i) => {
    lines.push(
      `${i + 1}. <a href="${escapeHtml(coinUrl(links, c.mint))}"><b>$${escapeHtml(c.ticker)}</b></a> · MC ${formatSolNumber(c.marketCapSol)} SOL · ${pct(c.change24hPct)}`,
      `    🛡 vault ${formatSolNumber(c.vault.floorSol)} SOL · 👥 ${c.holders}`,
    );
  });
  lines.push("", "<i>Look one up with /coin &lt;address&gt;</i>");
  return { html: lines.join("\n"), buttons: [[{ text: "See all on moatpad.fun", url: links.webUrl }]] };
}

export function burnsMessage(links: BotLinks, b: BurnStats): BotReply {
  const buy = { text: "🟢 Buy $MOATPAD", url: `https://pump.fun/coin/${links.moatCa}` };
  if (b.burns === 0) {
    return {
      html: [
        "🔥 <b>$MOATPAD buy &amp; burn</b>",
        "",
        "10% of every fee on every Moatpad coin buys $MOATPAD and burns it.",
        "No burn has happened yet: the first one comes as soon as a vault's burn share is big enough.",
        "",
        `CA: <code>${escapeHtml(links.moatCa)}</code>`,
      ].join("\n"),
      buttons: [[buy]],
    };
  }
  const lines = [
    "🔥 <b>$MOATPAD buy &amp; burn</b>",
    "",
    `Burned: <b>${formatCompact(b.tokensBurned)} $MOATPAD</b>`,
    `Spent: ${formatSolNumber(b.solSpent)} SOL in ${b.burns} ${b.burns === 1 ? "burn" : "burns"}`,
    "",
    "<b>Latest burns</b>",
    ...b.recent
      .slice(0, 5)
      .map((r) => `• ${formatCompact(r.tokensBurned)} $MOATPAD by the $${escapeHtml(r.ticker ?? shortAddress(r.mint))} vault · <a href="${escapeHtml(solscanTxUrl(r.sig, links.cluster))}">tx</a>`),
    "",
    "10% of every fee on every Moatpad coin buys and burns $MOATPAD.",
    `CA: <code>${escapeHtml(links.moatCa)}</code>`,
  ];
  return { html: lines.join("\n"), buttons: [[buy]] };
}

/** Posted to the burn channel for every burn. */
export function burnAlert(links: BotLinks, b: { ticker: string | null; mint: string; tokensBurned: number; solSpent: number; sig: string }): string {
  return [
    "🔥 <b>$MOATPAD burned!</b>",
    "",
    `The $${escapeHtml(b.ticker ?? shortAddress(b.mint))} vault bought and burned <b>${formatCompact(b.tokensBurned)} $MOATPAD</b> (${formatSolNumber(b.solSpent)} SOL).`,
    `<a href="${escapeHtml(solscanTxUrl(b.sig, links.cluster))}">View on Solscan</a> · <a href="${escapeHtml(coinUrl(links, b.mint))}">$${escapeHtml(b.ticker ?? shortAddress(b.mint))} on Moatpad</a>`,
  ].join("\n");
}

/** One green dot per 0.1 SOL, 1 to 25. */
export function buyDots(sol: number): string {
  return "🟢".repeat(Math.max(1, Math.min(25, Math.ceil(sol * 10 - 1e-9))));
}

/** The group buy bot's message for one buy. */
export function buyAlert(
  links: BotLinks,
  a: { coin: CoinLabel & { name?: string }; sol: number; tokens: bigint; wallet: string; sig: string; marketCapSol: number; floorSol: number | null; skipped: number },
): BotReply {
  const t = tickerText(a.coin);
  const lines = [
    `<b>$${t} Buy!</b>`,
    buyDots(a.sol),
    "",
    `💰 Spent: <b>${formatSolNumber(a.sol)} SOL</b>`,
    `🪙 Got: ${formatTokens(a.tokens, a.coin.decimals)} ${t}`,
    `👤 Buyer: <a href="${escapeHtml(solscanAccountUrl(a.wallet, links.cluster))}">${escapeHtml(shortAddress(a.wallet))}</a> · <a href="${escapeHtml(solscanTxUrl(a.sig, links.cluster))}">Txn</a>`,
    `📊 Market cap: ${formatSolNumber(a.marketCapSol)} SOL`,
  ];
  if (a.floorSol !== null) lines.push(`🛡 Floor vault: ${formatSolNumber(a.floorSol)} SOL`);
  if (a.skipped > 0) lines.push("", `<i>+${a.skipped} more ${a.skipped === 1 ? "buy" : "buys"} since the last alert</i>`);
  const buttons: Keyboard = [[{ text: `🟢 Buy $${a.coin.ticker.trim() || "it"}`, url: coinUrl(links, a.coin.mint) }]];
  const launch = botLink(links.botUsername, "launch");
  if (launch) buttons[0]!.push({ text: "🚀 Launch yours", url: launch });
  return { html: lines.join("\n"), buttons };
}

/** Progress of a launch started from the bot. Null for statuses that need no message. */
export function launchStatusMessage(
  links: BotLinks,
  l: { status: LaunchStatusKind; ticker: string; mint: string | null; receivedSol: number; refundSig: string | null; error: string | null },
): BotReply | null {
  const t = escapeHtml(l.ticker);
  switch (l.status) {
    case "deposit_received":
    case "creating":
      return { html: `✅ <b>Payment received</b> (${formatSolNumber(l.receivedSol)} SOL)\nCreating $${t} on pump.fun... this takes a few seconds.` };
    case "live": {
      if (!l.mint) return null;
      const url = coinUrl(links, l.mint);
      const tweet = `I just launched $${l.ticker} on @moatpad 🛡\nIts vault defends the floor and pays holders every 2 minutes.\n${url}`;
      const buttons: Keyboard = [[{ text: `🪙 Open $${l.ticker} on Moatpad`, url }]];
      const group = botLink(links.botUsername, `buybot_${l.mint}`, true);
      if (group) buttons.push([{ text: "➕ Add buy bot to your group", url: group }]);
      buttons.push([{ text: "🐦 Share on X", url: `https://x.com/intent/tweet?text=${encodeURIComponent(tweet)}` }]);
      return {
        html: [`🚀 <b>$${t} is LIVE!</b>`, "", `CA: <code>${escapeHtml(l.mint)}</code>`, "", "Share it with your community and turn on buy alerts in your group. 🎉"].join("\n"),
        buttons,
      };
    }
    case "refunded": {
      const lines = [`↩️ <b>Your $${t} launch was refunded.</b>`];
      if (l.error) lines.push(`Reason: ${escapeHtml(l.error)}`);
      if (l.refundSig) lines.push(`<a href="${escapeHtml(solscanTxUrl(l.refundSig, links.cluster))}">Refund on Solscan</a>`);
      lines.push("", "Send /launch to try again.");
      return { html: lines.join("\n") };
    }
    case "expired":
      return { html: `⌛ No payment arrived in time, so the $${t} launch expired.\nIf you sent SOL late, it will be refunded automatically. Send /launch to start again.` };
    case "failed": {
      // The launcher only marks a launch failed once its refund went out (refunding → failed).
      const lines = [`⚠️ The $${t} launch failed${l.error ? `: ${escapeHtml(l.error)}` : ""}.`];
      if (l.refundSig) lines.push(`Your SOL was refunded to the wallet that paid: <a href="${escapeHtml(solscanTxUrl(l.refundSig, links.cluster))}">Refund on Solscan</a>`);
      else lines.push("Anything left of your deposit goes back to the wallet that paid.");
      lines.push("", "Send /launch to try again.");
      return { html: lines.join("\n") };
    }
    default:
      return null;
  }
}
