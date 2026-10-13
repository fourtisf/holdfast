# @holdfast/launcher

The no-wallet launch flow of SPEC §5:
1. The API creates a `launches` row with a unique deposit address (HKDF from `DEPOSIT_MASTER_SECRET`).
2. The user sends SOL to that address.
3. This worker watches for the deposit, creates the coin on pump.fun with **creator = the coin's Holdfast treasury PDA**,
   registers its vault, optionally runs the dev buy, and refunds everything left over to the sender.

```bash
pnpm --filter @holdfast/launcher start         # worker (run exactly one instance)
pnpm --filter @holdfast/launcher cost 0.5 https://api.example/metadata [--rpc]   # cost breakdown
pnpm --filter @holdfast/launcher test
```

Required env: `DATABASE_URL`, `SOLANA_RPC_URL`, `LAUNCHER_KEYPAIR` (must equal `Config.launcher` on-chain; startup refuses
otherwise), `DEPOSIT_MASTER_SECRET`, `METADATA_STORE` (local directory served by the API at `/metadata`),
`PUBLIC_METADATA_BASE_URL`, `HOLDFAST_PROGRAM_ID`. Optional `LAUNCHER_*` settings are listed in the root `.env.example`.

## Transactions

| Tx | Contents | Fee payer / signers |
|---|---|---|
| A | compute budget + pump.fun `create_v2(creator = treasuryPda(mint), mayhem off)` | deposit / deposit + mint |
| B | deposit → launcher transfer of the exact rent the launcher fronts + Holdfast `init_coin(trigger)` + pump.fun `init_user_volume_accumulator(user = treasury)` | deposit / deposit + launcher |
| C (dev buy only) | deposit ATA + pump.fun `buy_v3` + sender ATA + `transfer_checked` of exactly the bought tokens + close the deposit ATA and its volume accumulator | deposit |
| Refund | everything left on the deposit, minus the fee, back to the sender | deposit |

- All legacy transactions, at most 1058 bytes.
- The launcher wallet needs no SOL float: the deposit reimburses it inside tx B.
- **Dev-buy tokens never earn.** They reach the sender by *transfer* (which never creates a lot), and tx C's signature is
  stored as the coin's `launch_sig`, which the indexer skips.
- **Crash safety.** Every broadcast is preceded by a DB write. Retries check on-chain state first, so a crash never
  double-creates or double-refunds. The mint keypair is stored encrypted (AES-256-GCM, key derived from the master secret)
  and reused across retries.

## Launch cost (default rent, 50k µlamports/CU priority fee)

| Item | Bytes | Lamports |
|---|---|---|
| pump.fun mint (MetadataPointer + TokenMetadata) | 438 | 3,939,360 |
| pump.fun bonding curve | 166 | 2,046,240 |
| pump.fun curve token account | 170 | 2,074,080 |
| Holdfast CoinVault | 1234 | 9,479,520 |
| treasury rent-exempt reserve | 0 | 890,880 |
| treasury token account | 170 | 2,074,080 |
| treasury WSOL account | 165 | 2,039,280 |
| treasury pump.fun volume accumulator | 137 | 1,844,400 |
| tx A / tx B / refund fees | – | 22,500 / 22,500 / 5,100 |
| **Consumed per launch** | | **24,437,940 ≈ 0.0244 SOL** |

- **This is above the spec's 0.015 SOL.** The pump.fun side is ≈ 0.0081 SOL and the Holdfast side ≈ 0.0163 SOL.
- The required deposit is `max(0.015 SOL, consumed + deposit rent reserve)` + dev buy + dev-buy accounts/fees + a
  refundable 5% slippage buffer: **0.025329 SOL** with no dev buy, 0.556341 SOL for a 0.5 SOL dev buy. Unused lamports
  are always refunded.
- The model lives in `@holdfast/chain` (`src/launch`), so the API's `GET /launch/quote` and `POST /launch` quote exactly
  what this worker waits for.
- **Getting under 0.015 SOL is a product decision** (docs/decisions.md #20). Either subsidise ≈ 0.01 SOL per launch, or
  shrink the vault account (its 32-slot TWAP ring is 768 bytes ≈ 0.0053 SOL) and create the treasury's WSOL account and
  accumulator lazily.

## Verify on devnet

- `create_v2` with mayhem off creates no extra accounts, and the mint size matches the computed size.
- `buy_v3` is available on devnet, and closing the deposit's volume accumulator in the same transaction is allowed
  (otherwise set `LAUNCHER_CLOSE_DEPOSIT_ACCUMULATOR=false`).
- Compute-unit limits: 250k / 250k / 300k / 2k.
- The time between tx A and tx B is a window where snipers can buy before the dev buy. Merging A + B (+ C) into one v0
  transaction with a lookup table would close it.
