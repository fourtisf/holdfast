import { describe, expect, it } from "vitest";

import { clip, coinUrl, ellipsize, formatMultiplier, formatPrice, formatSol, formatTokens, shortAddress, solscanTxUrl } from "../src/format.js";
import { defendMessage, graduatedMessage, milestoneMessage, payoutMessage, roundSummaryMessage } from "../src/messages.js";
import { escapeHtml } from "../src/telegram.js";
import { addr, LINKS, TOK } from "./helpers.js";

describe("escapeHtml", () => {
  it("escapes the characters Telegram's HTML mode cares about", () => {
    expect(escapeHtml(`<b>Tom & "Jerry"</b>`)).toBe("&lt;b&gt;Tom &amp; &quot;Jerry&quot;&lt;/b&gt;");
    expect(escapeHtml("plain")).toBe("plain");
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });
});

describe("formatSol", () => {
  it("keeps at most 4 significant decimals", () => {
    expect(formatSol(0n)).toBe("0");
    expect(formatSol(1_000_000_000n)).toBe("1");
    expect(formatSol(1_500_000_000n)).toBe("1.5");
    expect(formatSol(1_234_567_890n)).toBe("1.2346");
    expect(formatSol(12_345_678n)).toBe("0.01235");
    expect(formatSol(150_000_000n)).toBe("0.15");
    expect(formatSol(1_500n)).toBe("0.0000015");
    expect(formatSol(1n)).toBe("0.000000001");
    expect(formatSol(999_960_000n)).toBe("1");
    expect(formatSol(1_234_000_000_000n)).toBe("1,234");
    expect(formatSol(-25_000_000n)).toBe("-0.025");
  });
});

describe("formatTokens / formatPrice / formatMultiplier", () => {
  it("formats token amounts with the coin's decimals", () => {
    expect(formatTokens(1_234_567_890_000n, 6)).toBe("1,234,568");
    expect(formatTokens(1000n * TOK, 6)).toBe("1,000");
    expect(formatTokens(12_345_678n, 6)).toBe("12.3457");
    expect(formatTokens(1_500n, 6)).toBe("0.0015");
    expect(formatTokens(5n, 0)).toBe("5");
  });

  it("formats prices with 4 significant digits", () => {
    expect(formatPrice(1.5e-7)).toBe("0.00000015");
    expect(formatPrice(0.000123456)).toBe("0.0001235");
    expect(formatPrice(2)).toBe("2");
    expect(formatPrice(0)).toBe("0");
    expect(formatPrice(Number.NaN)).toBe("0");
  });

  it("formats weights", () => {
    expect(formatMultiplier(614_285n)).toBe("0.61x");
    expect(formatMultiplier(1_000_000n)).toBe("1.00x");
  });
});

describe("links", () => {
  it("builds coin and Solscan links per cluster", () => {
    expect(coinUrl(LINKS, "Mint1")).toBe("https://holdfast.example/coin/Mint1");
    expect(solscanTxUrl("Sig1", "mainnet-beta")).toBe("https://solscan.io/tx/Sig1");
    expect(solscanTxUrl("Sig1", "devnet")).toBe("https://solscan.io/tx/Sig1?cluster=devnet");
    expect(solscanTxUrl("Sig1", "localnet")).toBe("https://solscan.io/tx/Sig1?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899");
  });

  it("shortens addresses", () => {
    expect(shortAddress("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU")).toBe("7xKX…gAsU");
    expect(shortAddress("short")).toBe("short");
    expect(shortAddress("😀😀😀😀abcdefgh😀😀😀😀")).toBe("😀😀😀😀…😀😀😀😀");
  });

  it("cuts user text by characters, never inside an emoji", () => {
    expect(clip("ab😀cd", 3)).toBe("ab😀");
    expect(clip("ab", 3)).toBe("ab");
    expect(ellipsize("ab😀cd", 3)).toBe("ab😀…");
    expect(ellipsize("ab😀", 3)).toBe("ab😀");
  });
});

describe("messages", () => {
  const mint = addr("mint:hound");
  const wallet = addr("alice");
  const coin = { mint, ticker: "HOUND", decimals: 6 };
  const coinLink = `<a href="https://holdfast.example/coin/${mint}">$HOUND on Moatpad</a>`;

  it("payout: amount, optional tokens, wallet, coin page and Solscan", () => {
    expect(payoutMessage(LINKS, { coin, roundId: 42, wallet, sol: 12_345_678n, tokens: 1500n * TOK, sig: "PaySig" })).toBe(
      [
        "💰 You earned 0.01235 SOL (+ 1,500 HOUND) from $HOUND round #42",
        `Wallet <code>${shortAddress(wallet)}</code>`,
        `${coinLink} · <a href="https://solscan.io/tx/PaySig?cluster=devnet">Solscan</a>`,
      ].join("\n"),
    );
    // No tokens, no signature known: no token part, no Solscan link.
    const plain = payoutMessage(LINKS, { coin, roundId: 7, wallet, sol: 1_000_000_000n, tokens: 0n, sig: null });
    expect(plain.split("\n")[0]).toBe("💰 You earned 1 SOL from $HOUND round #7");
    expect(plain).not.toContain("solscan");
  });

  it("round summary for coin followers", () => {
    expect(roundSummaryMessage(LINKS, { coin, roundId: 3n, sol: 500_000_000n, tokens: 0n, holders: 2, closeSig: null })).toBe(
      ["Round #3 of $HOUND paid 0.5 SOL to 2 holders", coinLink].join("\n"),
    );
    expect(roundSummaryMessage(LINKS, { coin, roundId: 4, sol: 1n, tokens: 10n * TOK, holders: 1, closeSig: "C" }).split("\n")[0]).toBe(
      "Round #4 of $HOUND paid 0.000000001 SOL (+ 10 HOUND) to 1 holder",
    );
  });

  it("floor defence, graduation and milestones", () => {
    expect(defendMessage(LINKS, { coin, sol: 150_000_000n, price: 1.5e-7, floorPrice: 1.5e-7, sig: "DefSig" })).toBe(
      [
        "🛡 Floor defended: the $HOUND vault bought back 0.15 SOL at price 0.00000015 SOL",
        "Floor: 0.00000015 SOL per token",
        `${coinLink} · <a href="https://solscan.io/tx/DefSig?cluster=devnet">Solscan</a>`,
      ].join("\n"),
    );
    expect(graduatedMessage(LINKS, coin)).toBe(["🎓 $HOUND graduated to PumpSwap", coinLink].join("\n"));
    expect(milestoneMessage(LINKS, { coin, wallet, milestone: "0.5", multiplierPpm: 614_285n }).split("\n")[0]).toBe(
      "⚖️ Your $HOUND position reached 0.5x weight (now 0.61x); it keeps rising to 1.0x over 7 days of holding",
    );
    expect(milestoneMessage(LINKS, { coin, wallet, milestone: "1.0", multiplierPpm: 1_000_000n }).split("\n")[0]).toBe(
      "🏆 Your $HOUND position reached full weight (1.0x): it now earns its full share of every payout",
    );
  });

  it("escapes user-supplied tickers and falls back to the mint", () => {
    const evil = { mint, ticker: "<b>X&Y</b>", decimals: 6 };
    const text = graduatedMessage(LINKS, evil);
    expect(text).toContain("$&lt;b&gt;X&amp;Y&lt;/b&gt; graduated");
    expect(text).not.toContain("<b>X");
    expect(graduatedMessage(LINKS, { mint, ticker: " ", decimals: 6 }).split("\n")[0]).toBe(`🎓 $${shortAddress(mint)} graduated to PumpSwap`);
  });
});
