# @holdfast/launcher

The no-wallet launch flow of SPEC §5:
1. The API creates a `launches` row with a unique deposit address (HKDF from `DEPOSIT_MASTER_SECRET`).
2. The user sends SOL to that address.
3. This worker watches for the deposit, creates the coin on pump.fun with **creator = the coin's Moatpad treasury PDA**,
   registers its vault, optionally runs the dev buy, and refunds everything left over to the sender.

```bash
pnpm --filter @holdfast/launcher start         # worker (run exactly one instance)
pnpm --filter @holdfast/launcher cost 0.5 --atomic --ipfs [--rpc]   # cost breakdown
pnpm --filter @holdfast/launcher alt create|sync|show              # lookup table for atomic launches
pnpm --filter @holdfast/launcher test
```

Required env: `DATABASE_URL`, `SOLANA_RPC_URL`, `LAUNCHER_KEYPAIR` (must equal `Config.launcher` on-chain; startup refuses
otherwise), `DEPOSIT_MASTER_SECRET`, `METADATA_STORE` (local directory shared with the API, which serves it at `/metadata`),
`PUBLIC_METADATA_BASE_URL`, `HOLDFAST_PROGRAM_ID`. Production adds `METADATA_STORAGE=pinata` + `PINATA_JWT`, and
`LAUNCHER_LOOKUP_TABLE`. Optional `LAUNCHER_*` settings are listed in the root `.env.example`.

## Transactions

**Atomic flow** (`LAUNCHER_LOOKUP_TABLE` set; create the table once with `pnpm --filter @holdfast/launcher alt create`,
and run `alt sync` after pump.fun SDK upgrades):

| Tx | Contents | Fee payer / signers |
|---|---|---|
| L (v0 + lookup table) | compute budget + deposit → launcher reimbursement + pump.fun `create_v2(creator = treasuryPda(mint))` + Moatpad `init_coin(trigger)` + **either** the dev buy (`buy_v3`) **or** the exact leftover back to the sender | deposit / deposit + mint + launcher |
| D (dev buy only) | sender ATA + `transfer_checked` of exactly the bought tokens + close the deposit ATA and volume accumulator + the exact leftover back to the sender | deposit |

- **No sniping window.** The coin is created, registered and dev-bought in one transaction. Nothing can trade in between,
  and a failure changes nothing.
- **The deposit ends at exactly 0 lamports.** No rent reserve has to sit on it and no refund transaction is needed, so a
  typical launch costs **0.015 SOL flat** (see below).
- A leftover that an emptied sender wallet could not receive (below rent-exempt) goes to the coin's own treasury. There it
  is booked as fees (50/25/15/10).
- A transaction that would not fit one packet (a URI over ≈ 137 bytes plus a dev buy) uses the split flow right away.
  So does a launch whose atomic attempt was rejected `LAUNCHER_ATOMIC_ATTEMPTS` times, if its deposit covers the split
  flow; otherwise it is refunded.
- With `METADATA_STORAGE=pinata` the image and metadata JSON are pinned to IPFS (CIDv1, `IPFS_GATEWAY_URL/ipfs/<cid>`), so a
  coin's metadata outlives our servers.

**Split flow** (no lookup table, or fallback):

| Tx | Contents | Fee payer / signers |
|---|---|---|
| A | compute budget + pump.fun `create_v2(creator = treasuryPda(mint), mayhem off)` | deposit / deposit + mint |
| B | deposit → launcher transfer of the exact rent the launcher fronts + Moatpad `init_coin(trigger)` | deposit / deposit + launcher |
| C (dev buy only) | deposit ATA + pump.fun `buy_v3` + sender ATA + `transfer_checked` of exactly the bought tokens + close the deposit ATA and its volume accumulator | deposit |
| Refund | everything left on the deposit, minus the fee, back to the sender | deposit |

Both flows:
- The launcher wallet needs no SOL float: the deposit reimburses it in the same transaction.
- The launch does **not** create the treasury's token accounts or pump volume accumulator. The vault program's
  `prepare_treasury` creates them once the coin earns fees, paid out of its own floor bucket (≈ 0.006 SOL, keeper-driven).
- **Dev-buy tokens never earn.** They reach the sender by *transfer*, which never creates a lot. The transaction that buys
  them is stored as the coin's `launch_sig`, and the indexer skips it.
- **Crash safety.** Every broadcast is preceded by a DB write. Retries check on-chain state first, so a crash never
  double-creates, double-buys or double-refunds. The mint keypair is stored encrypted (AES-256-GCM, key derived from the
  master secret) and reused across retries.

## Launch cost (default rent, 50k µlamports/CU priority fee, 12-byte name, 5-byte ticker)

`pnpm --filter @holdfast/launcher cost [devBuySol] [--atomic] [--ipfs]` prints this table for your settings.

| Item | Bytes | Atomic + IPFS | Split + local metadata |
|---|---|---|---|
| pump.fun mint (MetadataPointer + TokenMetadata) | 415 / 438 | 3,779,280 | 3,939,360 |
| pump.fun bonding curve | 166 | 2,046,240 | 2,046,240 |
| pump.fun curve token account | 170 | 2,074,080 | 2,074,080 |
| Moatpad CoinVault | 730 | 5,971,680 | 5,971,680 |
| treasury rent-exempt reserve | 0 | 890,880 | 890,880 |
| transaction fees | – | 27,500 | 50,100 |
| **Consumed** | | **14,789,660 ≈ 0.0148 SOL** | **14,972,340 ≈ 0.0150 SOL** |
| **Required deposit** (unused part refunded) | | **0.015000 SOL** | 0.015863 SOL (+ deposit rent reserve) |

- The spec's 0.015 SOL is met. Before the vault was slimmed and the treasury accounts made lazy, the cost was 0.0244 SOL.
- A dev buy adds the buy itself, the sender's token account (0.0021 SOL), a delivery-tx fee and a refundable float
  (deposit token account, volume accumulator, 5% slippage, and in atomic mode the deposit's rent reserve until delivery).
  Example: 0.546913 SOL required for a 0.5 SOL dev buy (atomic + IPFS).
- The model lives in `@holdfast/chain` (`src/launch`). The launcher and the API both build the plan from the same
  variables (`launchPlanFromEnv`), so `GET /launch/quote` and `POST /launch` quote exactly what this worker waits for.

## Verify on devnet

- `create_v2` with mayhem off creates no extra accounts, and the mint size matches the computed size.
- `buy_v3` is available on devnet, and closing the deposit's volume accumulator in the same transaction is allowed
  (otherwise set `LAUNCHER_CLOSE_DEPOSIT_ACCUMULATOR=false`).
- Compute-unit limits: 250k / 250k / 300k / 2k.
- The atomic transaction (create_v2 + init_coin + buy_v3 in one v0 transaction) lands, and its compute fits the
  250k / 450k limits.
- `prepare_treasury` can CPI into pump's `init_user_volume_accumulator` with the treasury PDA as payer.
