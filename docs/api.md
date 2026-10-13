# Holdfast API

Base URL: `NEXT_PUBLIC_API_URL` (default `http://localhost:4000`). All response bodies are JSON and typed in
[`packages/core/src/api.ts`](../packages/core/src/api.ts). Errors: `{ "error": string }` with a 4xx/5xx status.

| Method | Path | Response | Notes |
|---|---|---|---|
| GET | `/stats` | `Stats` | 4 stat cards + payout `schedule` |
| GET | `/schedule` | `Schedule` | Round clock, used to sync the sidebar countdown |
| GET | `/coins?sort=&q=&limit=&cursor=` | `Page<CoinSummary>` | `sort`: `newest` (default) · `trending` · `vault_buying` · `top_payouts` · `biggest_vault`; `q` matches name/ticker/mint |
| GET | `/coins/:mint` | `CoinDetail` | |
| GET | `/coins/:mint/candles?tf=1m\|5m\|15m\|1h&from=&to=` | `CandlesResponse` | includes floor line and "V" defend markers |
| GET | `/coins/:mint/trades?limit=&before=` | `Page<Trade>` | tab **Trades** (`before` = cursor) |
| GET | `/coins/:mint/holders?limit=` | `Holder[]` | tab **Holders** and "Top holders by weight" (sorted by `weightedTokens`) |
| GET | `/coins/:mint/defends?limit=` | `DefendEvent[]` | tab **Vault buys** |
| GET | `/coins/:mint/rounds?limit=` | `RoundSummary[]` | |
| GET | `/coins/:mint/rounds/:roundId` | `RoundSnapshot` | public, verifiable snapshot (see docs/payouts.md) |
| GET | `/me?wallet=` | `Profile` | profile page (public data, keyed by wallet address) |
| GET | `/me/position?wallet=&mint=` | `Position \| null` | "Your share" panel |
| POST | `/trade/quote` | `TradeQuote` | body `TradeQuoteRequest` |
| POST | `/trade/build` | `TradeBuildResponse` | body `TradeQuoteRequest`; returns unsigned tx for the wallet to sign |
| POST | `/uploads/image` | `{ imageUrl: string }` | `multipart/form-data` field `file` (png/jpg/gif/webp, ≤ 5 MB) |
| POST | `/launch` | `LaunchResponse` | body `LaunchRequest`; creates a unique deposit address |
| GET | `/launch/:id` | `LaunchStatus` | |

## WebSocket `/ws`

Client → server: `WsClientMessage`. Server → client: `WsServerMessage`.

```jsonc
{ "type": "subscribe", "channel": "trades", "mint": "<mint>" }        // live trades + vault + round updates for a coin
{ "type": "subscribe", "channel": "deposit-status", "launchId": "<id>" } // launch modal progress
{ "type": "subscribe", "channel": "stats" }                            // stat cards (every ~10s)
{ "type": "ping" }                                                     // → { "channel": "pong", "serverTime": ms }
```

A `trades` subscription also receives `vault` (vault snapshot changed) and `round` (payout round progressed)
messages for the same mint.
