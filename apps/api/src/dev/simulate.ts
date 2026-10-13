import { tradePrice } from "@holdfast/core";
import { getCoinMetrics, insertTrade, listCoins, notify, updateLastPrice, upsertCandles, type Db } from "@holdfast/db";

/**
 * Dev-only market simulator: every `intervalMs` a random demo coin gets a small trade and a
 * `holdfast_events` notification, so the WebSocket feed and charts move without a chain.
 */
export function startSimulator(db: Db, opts: { intervalMs: number; log: (msg: string) => void }): () => void {
  let n = 0;
  const tick = async () => {
    const coins = await listCoins(db);
    if (coins.length === 0) return;
    const coin = coins[Math.floor(Math.random() * coins.length)]!;
    const m = await getCoinMetrics(db, coin.mint, Date.now());
    const price = m?.price || 3e-8;
    const isBuy = Math.random() < 0.55;
    const sol = BigInt(Math.floor((0.02 + Math.random() * 0.8) * 1e9));
    const drift = isBuy ? 1 + Math.random() * 0.01 : 1 - Math.random() * 0.01;
    const tokens = BigInt(Math.max(1, Math.floor((Number(sol) / 1e9 / (price * drift)) * 1e6)));
    const now = Date.now();
    const sig = `sim${now}${n++}`.padEnd(64, "1");
    await db.tx(async (q) => {
      await insertTrade(q, {
        sig,
        ixIndex: 0,
        mint: coin.mint,
        wallet: "SimTrader11111111111111111111111111111111111",
        side: isBuy ? "buy" : "sell",
        sol,
        tokens,
        price: tradePrice(sol, tokens),
        ts: now,
        slot: 1_000_000_000 + n,
        source: coin.graduated ? "pumpswap" : "curve",
      });
      await upsertCandles(q, { mint: coin.mint, ts: now, price: tradePrice(sol, tokens), volume: sol, slot: 1_000_000_000 + n });
      await updateLastPrice(q, coin.mint, price * drift, now, 1_000_000_000 + n);
      await notify(q, { kind: "trade", mint: coin.mint, sig });
    });
  };
  const timer = setInterval(() => {
    tick().catch((err: Error) => opts.log(`simulator: ${err.message}`));
  }, opts.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
