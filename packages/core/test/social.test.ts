import { describe, expect, it } from "vitest";

import { bondingCurveProgress, commentMessage, normalizeCommentBody, positionPnl, PUMP_INITIAL_REAL_TOKEN_RESERVES } from "../src/index.js";

describe("launchpad helpers", () => {
  it("bonding curve progress goes 0 → 1 as the curve sells out", () => {
    expect(bondingCurveProgress(PUMP_INITIAL_REAL_TOKEN_RESERVES, false)).toBe(0);
    expect(bondingCurveProgress(PUMP_INITIAL_REAL_TOKEN_RESERVES / 4n, false)).toBe(0.75);
    expect(bondingCurveProgress(0n, false)).toBe(1);
    expect(bondingCurveProgress(null, false)).toBe(0);
    expect(bondingCurveProgress(PUMP_INITIAL_REAL_TOKEN_RESERVES, true)).toBe(1);
  });

  it("PnL counts sells and payouts as money out", () => {
    const pnl = positionPnl({ boughtSol: 1, soldSol: 0.5, valueSol: 0.8, earnedSol: 0.1, earnedTokensValueSol: 0.05 });
    expect(pnl.pnlSol).toBeCloseTo(0.45, 12);
    expect(pnl.pnlPct).toBeCloseTo(45, 9);
    expect(positionPnl({ boughtSol: 0, soldSol: 0, valueSol: 2, earnedSol: 0, earnedTokensValueSol: 0 }).pnlPct).toBeNull();
  });

  it("the signed comment message is stable and readable", () => {
    const msg = commentMessage({ mint: "Mint111", body: "  gm\r\n\r\n\r\n\r\n\r\nfrens ", replyTo: null, signedAt: Date.UTC(2026, 9, 14, 7, 0, 0) });
    expect(msg).toBe("Moatpad comment\ncoin: Mint111\nreply to: -\nsigned at: 2026-10-14T07:00:00.000Z\n\ngm\n\n\nfrens");
    expect(normalizeCommentBody("a\r\nb")).toBe("a\nb");
  });
});
