/** Bot message texts (Telegram HTML). Every user-supplied string goes through escapeHtml. */
import { coinUrl, formatMultiplier, formatPrice, formatSol, formatTokens, shortAddress, solscanTxUrl, type Links } from "./format.js";
import { escapeHtml } from "./telegram.js";

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
  return link(coinUrl(links, coin.mint), `$${coin.ticker.trim() || shortAddress(coin.mint)} on Holdfast`);
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
