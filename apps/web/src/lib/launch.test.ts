import { describe, expect, it } from "vitest";
import {
  amountDue,
  creatingStepsText,
  creatorFeesRecipient,
  isLaunchId,
  lamportsToSolExact,
  launchFailureText,
  liveLaunchNotes,
  nameBytes,
  normalizeSocial,
  normalizeTicker,
  parseDevBuy,
  partialDeposit,
  requiredDepositSol,
  solanaPayUrl,
  toLaunchRequest,
  validateLaunch,
  type LaunchForm,
} from "./launch";

const base: LaunchForm = { name: "Kelp Lord", ticker: "KELP", description: "", imageUrl: null, x: "", telegram: "", website: "", triggerBps: 2500, devBuy: "", creatorWallet: "" };

describe("normalizeTicker", () => {
  it("uppercases and strips non-alphanumerics", () => {
    expect(normalizeTicker("$kelp lord!")).toBe("KELPLORD");
    expect(normalizeTicker("abcdefghijklmnop")).toBe("ABCDEFGHIJ");
  });
});

describe("normalizeSocial", () => {
  it("turns handles into links", () => {
    expect(normalizeSocial("x", "@kelplord")).toBe("https://x.com/kelplord");
    expect(normalizeSocial("telegram", "kelplord")).toBe("https://t.me/kelplord");
  });
  it("accepts matching URLs and rejects foreign hosts", () => {
    expect(normalizeSocial("x", "https://twitter.com/kelp")).toBe("https://twitter.com/kelp");
    expect(normalizeSocial("telegram", "t.me/kelp")).toBe("https://t.me/kelp");
    expect(normalizeSocial("x", "https://example.com/kelp")).toBeNull();
  });
  it("adds https to websites", () => {
    expect(normalizeSocial("website", "kelplord.fun")).toBe("https://kelplord.fun/");
    expect(normalizeSocial("website", "not a url")).toBeNull();
    expect(normalizeSocial("website", "  ")).toBeNull();
  });
});

describe("deposit amount", () => {
  it("adds the 0.015 SOL launch cost to the dev buy", () => {
    // fallback (spec fee) until the quote loads, then the quoted amount
    expect(requiredDepositSol(0)).toBe(0.015);
    expect(requiredDepositSol(0.5)).toBe(0.515);
    expect(requiredDepositSol(0.1 + 0.2)).toBe(0.315);
    const quote = { launchFeeSol: 0.025329, devBuySol: 0.5, devBuyExtraSol: 0.031, requiredSol: 0.556329, requiredLamports: "556329000", specFeeSol: 0.015, exceedsSpecFee: true };
    expect(requiredDepositSol(0.5, quote)).toBe(0.556329);
  });
  it("parses dev buy input", () => {
    expect(parseDevBuy("")).toBe(0);
    expect(parseDevBuy("1.5")).toBe(1.5);
    expect(parseDevBuy("-1")).toBeNull();
    expect(parseDevBuy("abc")).toBeNull();
  });
});

describe("validateLaunch", () => {
  it("accepts a minimal form", () => {
    expect(validateLaunch(base)).toEqual({});
  });
  it("flags missing and invalid fields", () => {
    const errors = validateLaunch({ ...base, name: " ", ticker: "", website: "nope", devBuy: "500", creatorWallet: "not a wallet" });
    expect(Object.keys(errors).sort()).toEqual(["creatorWallet", "devBuy", "name", "ticker", "website"]);
  });
  it("measures the name in UTF-8 bytes, like pump.fun (the launcher refuses longer names after payment)", () => {
    expect(nameBytes(" Crème Brûlée ")).toBe(15);
    for (const name of ["Пушистый Кот Монета", "Crème Brûlée Pâtisserie Royale", "🐸 Frog King of the Pond 🐸👑"]) {
      expect(validateLaunch({ ...base, name }).name, name).toBe("Too long for pump.fun: accented letters and emoji take 2 to 4 of the 32 allowed");
    }
    expect(validateLaunch({ ...base, name: "x".repeat(33) }).name).toBe("Max 32 characters");
    expect(validateLaunch({ ...base, name: "Café Moat Dog Coin of the Ponds" }).name).toBeUndefined();
  });
});

describe("launch progress", () => {
  it("shows the reason of a refused form, never the launcher's internal error", () => {
    expect(launchFailureText("invalid launch: name must be 1-32 bytes")).toBe("name must be 1-32 bytes");
    expect(launchFailureText("launch failed after 6 attempts (atomic: simulation failed: ... [rejected 5ig])")).toBe("Something went wrong on our side while creating the coin.");
    expect(launchFailureText(null)).toBeNull();
  });
  it("says when a live launch skipped its dev buy or still owes a refund", () => {
    expect(liveLaunchNotes("dev buy skipped after 6 failed attempts; its SOL was refunded; refund pending: x")).toEqual([
      "Your dev buy could not be made: its SOL goes back to the wallet that paid, and you hold no tokens from it.",
      "Your leftover SOL is still being refunded to the wallet that paid.",
    ]);
    expect(liveLaunchNotes(null)).toEqual([]);
  });
  it("says who gets the creator fees on the payment screen (a payment link can be for someone else's launch)", () => {
    const wallet = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
    expect(creatorFeesRecipient(wallet)).toBe(wallet);
    expect(creatorFeesRecipient(null)).toBe("The wallet you pay from");
  });
  it("describes the creation without calling the vault the creator, and mentions a dev buy only when there is one", () => {
    expect(creatingStepsText(0)).toBe("pump.fun creator fees routed to the coin's vault, floor locked.");
    expect(creatingStepsText(0.5)).toBe("pump.fun creator fees routed to the coin's vault, floor locked, dev buy.");
  });
  it("tells how much of a short deposit is missing", () => {
    expect(partialDeposit({ receivedLamports: "23450000", requiredLamports: "23456789" })).toEqual({ receivedLamports: 23_450_000n, missingLamports: 6_789n });
    expect(partialDeposit({ receivedLamports: "0", requiredLamports: "23456789" })).toBeNull();
    expect(partialDeposit({ receivedLamports: "23456789", requiredLamports: "23456789" })).toBeNull();
    expect(lamportsToSolExact(6_789n)).toBe("0.000006789");
    // The payment screen (QR code, wallet link, amount) asks only for what is missing, from the launch as it is now.
    expect(amountDue("23456789", { receivedLamports: "23450000", requiredLamports: "23456789" })).toBe(6_789n);
    expect(amountDue("23456789", { receivedLamports: "0", requiredLamports: "23500000" })).toBe(23_500_000n);
    expect(amountDue("23456789", null)).toBe(23_456_789n);
    expect(lamportsToSolExact(2_000_000_000n)).toBe("2");
  });
});

describe("toLaunchRequest", () => {
  it("normalises socials and omits empty optionals", () => {
    expect(toLaunchRequest(base)).toEqual({
      name: "Kelp Lord",
      ticker: "KELP",
      description: undefined,
      imageUrl: undefined,
      socials: undefined,
      triggerBps: 2500,
      devBuySol: undefined,
      creatorWallet: undefined,
    });
    const req = toLaunchRequest({ ...base, x: "@kelp", devBuy: "0.5", description: " hi ", imageUrl: "https://img" });
    expect(req.socials).toEqual({ x: "https://x.com/kelp" });
    expect(req.devBuySol).toBe(0.5);
    expect(req.description).toBe("hi");
    expect(req.imageUrl).toBe("https://img");
    const wallet = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
    expect(toLaunchRequest({ ...base, creatorWallet: ` ${wallet} ` }).creatorWallet).toBe(wallet);
  });
});

describe("pay page", () => {
  it("only looks up launch ids that are UUIDs", () => {
    expect(isLaunchId("3326d68a-e134-4e5c-abc9-d433a7ffbfc3")).toBe(true);
    expect(isLaunchId("3326D68A-E134-4E5C-ABC9-D433A7FFBFC3")).toBe(true);
    expect(isLaunchId("not-a-launch")).toBe(false);
    expect(isLaunchId("x".repeat(120))).toBe(false);
    expect(isLaunchId("3326d68a-e134-4e5c-abc9-d433a7ffbfc3/extra")).toBe(false);
  });

  it("builds the same solana: URI as the API, with the exact amount", () => {
    const address = "FtbBXcTHnkdhdHYv2NWVSjzrtSoDurHmb4Ts9LR3xaA";
    expect(solanaPayUrl(address, "74285300", "TGPAY")).toBe(`solana:${address}?amount=0.0742853&label=Moatpad&message=Launch%20%24TGPAY`);
    expect(solanaPayUrl(address, "10073173658", "BIG")).toContain("amount=10.073173658&");
    expect(solanaPayUrl(address, "2000000000", "TWO")).toContain("amount=2&");
    expect(solanaPayUrl(address, "1", "DUST")).toContain("amount=0.000000001&");
  });
});
