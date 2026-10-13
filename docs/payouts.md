# Payout rounds and public snapshots

Rounds start every **2 minutes** on the wall clock (`nextRoundAt` in `@holdfast/core/schedule`), which is the same clock the API
serves to the frontend countdown. The payout worker (`apps/keeper`, `start:payout`) runs this sequence per coin:

1. **Collect.** Claim pump.fun creator fees into the treasury and run `collect_fees`, so the holder bucket is fresh.
2. **Snapshot inputs.**
   - `holder_sol` / `holder_tokens` from the `CoinVault` on-chain (the pot).
   - Every wallet with open purchase lots (indexer DB, excluded addresses removed).
   - Each wallet's SOL balance and token-account existence, read from chain.
   - The carry book: amounts owed from earlier rounds.
3. **Compute** with `computeRound` (pure, in `packages/core/src/payout.ts`):
   - `weight_ppm(age) = 100_000 + 900_000 × min(age_s, 604_800) / 604_800`, i.e. 0.1× → 1.0× over 7 days.
   - `W_wallet = Σ lot.amount × weight_ppm(now − lot.acquired_at)`.
   - `distributable = pot − Σ outstanding carries`. Carries are still inside the on-chain bucket, so subtracting them prevents double counting.
   - `share = floor(distributable × W / ΣW)` and `owed = share + carry`.
   - Paid now if `owed ≥ minimum` and, for SOL, `wallet_balance + owed ≥ rent-exempt minimum`. Otherwise owed is **carried** (dust is never lost).
   - Tokens are paid only when the wallet already has a token account (holders always do).
   - Floor-division remainders stay in the bucket.
   - Carries of wallets that no longer hold expire after `PAYOUT_CARRY_EXPIRY_MS` (default 30 days) and return to the pot.
4. **Publish.** The full snapshot (inputs + outputs) is stored in `payout_rounds.snapshot` and served publicly at
   `GET /coins/:mint/rounds/:roundId`.
5. **Commit.** `open_round(round_id, sol_pot, token_pot, merkle_root, recipient_count)`. The program refuses a pot larger than
   the holder buckets and allows only one open round at a time, at least `min_round_interval_secs` apart.
6. **Pay.** `payout` batches are packed under the 1232-byte transaction limit (≈ 8–12 recipients each). The program enforces:
   - recipients are regular wallets (system-owned, no data, on-curve), so pools and PDAs can never receive;
   - each index can be paid only once (on-chain bitmap);
   - running totals never exceed the committed pot;
   - a first SOL payout must leave the wallet rent-exempt.
7. **Reconcile + close.** The on-chain bitmap is the source of truth. Entries it doesn't mark as paid are carried. Then
   `close_round` refunds the round account's rent to the keeper. If the worker crashed with a round still open, the next
   cycle resumes that round from the stored snapshot instead of computing a new one.

## Merkle root (the `snapshot_hash` committed on-chain)

```
leaf_i = sha256(0x00 ‖ "holdfast:payout:v1" ‖ mint[32] ‖ round_id:u64le ‖ index:u32le ‖ wallet[32] ‖ sol:u64le ‖ tokens:u64le)
node   = sha256(0x01 ‖ min(a, b) ‖ max(a, b))       # sorted pair, no left/right flags
odd node at the end of a level is promoted; empty tree root = 32 zero bytes
```

Entries are sorted by wallet (base58), and `index` is the position in that order. A test vector pins the encoding
(`packages/core/test/merkle.test.ts`). A later program version can verify claims against these roots directly (SPEC §7.3).

## Verifying a round yourself

```bash
pnpm --filter @holdfast/keeper verify-round -- --api https://<api> --mint <MINT> --round <ID> --rpc https://<rpc>
```

This downloads the snapshot and re-runs `computeRound(snapshot.inputs)`. It checks every entry, the carries and the merkle
root, then finds the `RoundOpened` event of that round on-chain and compares the committed root. Any program can do the same
with `verifyRoundSnapshot` from `@holdfast/core`.

What the snapshot proves:
- The amounts follow the published formula from the published inputs.
- The amounts match what the program committed to before paying.

What it does **not** prove by itself: that the published lots are the true on-chain purchase history. To check that, replay
the coin's trades (all public) through the lot rules (`packages/core/src/lots.ts`). Moving lot tracking on-chain, or into an
on-chain-verified claim, is a later step (SPEC §7.3).
