# Moatpad API

Base URL: `NEXT_PUBLIC_API_URL` (default `http://localhost:4000`). All response bodies are JSON and typed in
[`packages/core/src/api.ts`](../packages/core/src/api.ts). Errors: `{ "error": string }` with a 4xx/5xx status.

| Method | Path | Response | Notes |
|---|---|---|---|
| GET | `/stats` | `Stats` | 4 stat cards + payout `schedule` + `solUsd` (Pyth Hermes, CoinGecko fallback; null when unknown) |
| GET | `/schedule` | `Schedule` | Round clock, used to sync the sidebar countdown |
| GET | `/coins?sort=&q=&limit=&cursor=` | `Page<CoinSummary>` | `sort`: `newest` (default) · `trending` · `vault_buying` · `top_payouts` · `biggest_vault`; `q` matches name/ticker/mint. Filters: `graduated=true\|false`, `maxAgeHours=`, `minMcapSol=`, `mints=a,b,…` (watchlist, ≤ 100) |
| GET | `/coins/:mint` | `CoinDetail` | |
| GET | `/coins/:mint/candles?tf=1m\|5m\|15m\|1h&from=&to=` | `CandlesResponse` | includes floor line and "V" defend markers |
| GET | `/coins/:mint/trades?limit=&before=` | `Page<Trade>` | tab **Trades** (`before` = cursor) |
| GET | `/coins/:mint/holders?limit=` | `Holder[]` | tab **Holders** and "Top holders by weight" (sorted by `weightedTokens`) |
| GET | `/coins/:mint/defends?limit=` | `DefendEvent[]` | tab **Vault buys** |
| GET | `/coins/:mint/rounds?limit=` | `RoundSummary[]` | |
| GET | `/coins/:mint/rounds/:roundId` | `RoundSnapshot` | public, verifiable snapshot (see docs/payouts.md) |
| GET | `/me?wallet=` | `Profile` | profile page (public data, keyed by wallet address) |
| GET | `/me/position?wallet=&mint=` | `Position \| null` | "Your share" panel, with SOL bought/sold and PnL (payouts included) |
| GET | `/me/trades?wallet=&limit=&before=` | `Page<WalletTrade>` | a wallet's trades across coins, newest first |
| GET | `/leaderboard?kind=&days=&limit=` | `Leaderboard` | `kind`: `earners` (payout SOL; `days` limits the period) · `diamond_hands` (oldest open lot per wallet) · `creators` (what their coins paid holders) · `coins` (top payouts) |
| GET | `/creators/:wallet` | `CreatorProfile` | coins a wallet launched and their record |
| GET | `/coins/:mint/comments?limit=&before=` | `Page<Comment>` | newest first, `before` = comment id; holder (with weight) and creator badges; hidden comments come with an empty body |
| POST | `/coins/:mint/comments` | `Comment` | body `PostCommentRequest`: the wallet's ed25519 signature (base58) over `commentMessage()` from @holdfast/core; signed at most 10 min ago; 1–500 chars; 3/min per wallet, 20/10 min per IP; blocked terms 422, replayed signature 409 |
| POST | `/comments/:id/report` | `ReportResponse` | like coin reports; `MODERATION_AUTO_HIDE_REPORTS` hides a comment too |
| POST | `/trade/quote` | `TradeQuote` | body `TradeQuoteRequest` (optional `priorityMicroLamports` ≤ 40,000,000 sets the compute-unit price of the built transaction) |
| POST | `/trade/build` | `TradeBuildResponse` | body `TradeQuoteRequest`; returns unsigned tx for the wallet to sign |
| POST | `/uploads/image` | `{ imageUrl: string }` | `multipart/form-data` field `file` (png/jpg/gif/webp, ≤ 5 MB) |
| GET | `/launch/quote?devBuySol=&name=&ticker=` | `LaunchQuote` | real launch cost (rent + fees) from the launcher's cost model and plan (atomic or split flow, metadata storage); 0.015 SOL for a typical atomic launch, never less |
| POST | `/launch` | `LaunchResponse` | body `LaunchRequest`; creates a unique deposit address; `requiredLamports` = the quote |
| GET | `/launch/:id` | `LaunchStatus` | |
| POST | `/coins/:mint/report` | `ReportResponse` | body `ReportRequest` (`reason`: scam · impersonation · nsfw · hate · illegal · other); one per visitor and coin; 10/hour per IP |

A coin hidden by moderators is left out of `/coins` and `/stats`. `GET /coins/:mint` still answers with `hidden: true` and
`hiddenReason`, and with `imageUrl`, `description` and `socials` withheld. Launch text with blocked terms is refused by
`POST /launch` (422), and blocked images by `POST /uploads/image` (422).

## Admin (`Authorization: Bearer $ADMIN_TOKEN`; 404 when ADMIN_TOKEN is unset)

Nothing here can touch funds. Moderation only changes what Moatpad lists and shows, and every action is logged.

| Method | Path | Response | Notes |
|---|---|---|---|
| GET | `/admin/overview` | `AdminOverview` | launches by status, open reports, coins to review, hidden coins |
| GET | `/admin/coins` | `AdminCoin[]` | reported, flagged (reserved name) and hidden coins |
| POST | `/admin/coins/:mint/hide` | `{ ok }` | body `HideCoinRequest` (`reason`, optional `blockImage`); resolves its reports |
| POST | `/admin/coins/:mint/unhide` | `{ ok }` | |
| POST | `/admin/coins/:mint/reviewed` | `{ ok }` | clears the review flag and dismisses its reports |
| GET | `/admin/reports?all=0\|1` | `AdminReport[]` | open reports (or all) |
| POST | `/admin/reports/:id/resolve` | `{ ok }` | body `{ resolution }` |
| POST | `/admin/comments/:id/hide` | `{ ok }` | body `{ reason }`; resolves its reports |
| POST | `/admin/comments/:id/unhide` | `{ ok }` | |
| GET | `/admin/launches?status=a,b` | `AdminLaunch[]` | |
| POST | `/admin/launches/:id/retry` | `AdminLaunch` | resets the attempt counter of a `creating` / `refunding` launch (the in-flight guard still applies) |
| GET | `/admin/log` | `AdminLogEntry[]` | audit trail |

The web app's `/admin` page is a console for these endpoints.

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
