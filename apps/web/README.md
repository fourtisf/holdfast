# @holdfast/web

Next.js 15 (App Router) frontend for the Moatpad launchpad: coins list, coin page with live chart and
trading, launch flow with deposit QR, profile, and the "How it works" modal (docs/SPEC.md §6).

> **Prototype note.** The spec says the UI must match `holdfast-launchpad.html`, but that file was not
> available when this app was built. The design here is an original dark, trader-oriented take on the
> spec text. The visual layer is isolated so it can be re-skinned to the prototype later:
>
> | What | Where |
> |---|---|
> | Design tokens (colors, fonts, radii, shadows, animations, breakpoints) | `src/styles/theme.css` (Tailwind v4 `@theme`) |
> | Wallet-adapter button/modal re-skin | `src/styles/wallet-adapter.css` |
> | Global base styles and custom utilities | `src/app/globals.css` |
> | App shell (nav, sidebar, mobile tab bar) | `src/app/layout.tsx`, `src/components/layout/*` |
> | Reusable primitives (Button, Card, Badge, Modal, Tabs, ...) | `src/components/ui/*` |
> | Mascot fallback for coins without an image | `src/components/coin/Mascot.tsx` (palette in `src/lib/hash.ts`) |
>
> Chart colors are read from the same CSS tokens at runtime, so changing `theme.css` re-colors the chart too.

## Run

```bash
pnpm install                       # from the repo root
cd apps/web
cp .env.example .env.local         # adjust API / WS / RPC URLs

pnpm dev                           # http://localhost:3000 against the real API
pnpm dev:mock                      # same, with generated data (NEXT_PUBLIC_USE_MOCKS=1), no backend needed

pnpm typecheck
pnpm test                          # vitest: formatters, clock sync, chart helpers, launch form, WS client, mock market
NEXT_PUBLIC_USE_MOCKS=1 pnpm build && NEXT_PUBLIC_USE_MOCKS=1 pnpm start
```

`NEXT_PUBLIC_*` variables are inlined at build time, so mock mode must be set for `build`, not only `start`.

| Variable | Default | |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | REST base (docs/api.md) |
| `NEXT_PUBLIC_WS_URL` | `ws://localhost:4000/ws` | WebSocket |
| `NEXT_PUBLIC_SOLANA_CLUSTER` | `devnet` | explorer links + wallet network |
| `NEXT_PUBLIC_SOLANA_RPC_URL` | public RPC for the cluster | used for sending/confirming trades |
| `NEXT_PUBLIC_USE_MOCKS` | `0` | `1` = in-browser simulated API, WS and a demo wallet |

### Screenshots / smoke test

With a mock-mode server running on :3000:

```bash
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers pnpm screenshots
```

`scripts/screenshots.mjs` walks every page at 1440×900 and 390×844 (coins grid/table, How it works,
connect demo wallet, coin page + buy, profile by `?wallet=`, full create → deposit → live → redirect),
fails on console errors, failed requests or horizontal page overflow, and writes PNGs to `screenshots/`.

## Structure

```
src/
  app/                    routes: / · /coin/[mint] · /create · /profile (+ ?wallet=) · not-found
  components/
    layout/               TopNav, Sidebar, PayoutCountdown (card + mobile pill), MobileTabBar, WalletButton
    coins/                stat cards, filter chips, search, grid cards, table
    coin-page/            header, market cap, CandleChart (lightweight-charts), activity tabs,
                          TradePanel, VaultPanel, SharePanel, TopHolders
    create/               form, ImageDrop, TriggerPicker, LaunchPreview, DepositModal
    profile/              ProfileView
    how-it-works/         modal + context (open it from anywhere with useHowItWorks())
    coin/                 CoinAvatar, Mascot, FloorAthBar, badges, FeeSplitBar, WeightRamp
    providers/            wallet/SWR providers, ScheduleProvider (server-synced round clock)
    ui/                   primitives + icons
  lib/
    api.ts                typed client for every endpoint in docs/api.md (types from @holdfast/core)
    ws.ts                 shared reconnecting WebSocket: ref-counted subscriptions, replay on reconnect, ping
    hooks/                SWR queries, live hooks (useTrades, useCoinChannel, useCoinLive, useDepositStatus, useLiveStats)
    clock.ts              payout countdown math (offset = serverTime + RTT/2 − now, roll by interval)
    chart.ts              floor step-line + "V" marker bucketing, live trade → candle folding
    format.ts             SOL / market cap / price (0.0₇281) / % / relative time / addresses
    launch.ts             launch form validation and request building
    solana.ts             base64 → VersionedTransaction, confirmation
    mocks/                mock market simulation, mock API, mock socket, demo wallet adapter
```

## Data flow

- REST through `api` (SWR for caching and refresh). Live updates arrive over one shared socket; components
  subscribe to the channels they need (`trades` also carries `vault` and `round` messages) and patch the
  SWR cache, so the header, chart, trades list and vault panel stay in step.
- The payout countdown samples `GET /schedule` on load, every 60s and when the tab becomes visible, and
  counts down on the server clock (`src/lib/clock.ts`).
- Trading follows the pump.fun flow: `POST /trade/quote` (debounced) → `POST /trade/build` → wallet
  `sendTransaction` → confirm → explorer link.
- Launching needs no wallet: `POST /launch` → deposit modal (Solana Pay QR, address, amount, expiry
  countdown) → status from WS `deposit-status`, with `GET /launch/:id` polling every 3s whenever the socket
  is not connected → redirect to the coin when live.

## Mock mode

`NEXT_PUBLIC_USE_MOCKS=1` swaps the API client and the socket transport for in-browser simulations
(`src/lib/mocks/`), loaded lazily so they are not part of a normal build's runtime path:

- 36 coins with deterministic 1-minute price paths. The vault mechanism is replayed over each path
  (50/25/15/10 fee split, 15-minute TWAP ATH, floor = ATH × (1 − trigger), 10% buybacks with cooldown, rounds
  every 2 minutes), so cards, chart overlays, vault panel and stats agree. A few coins use sample uploaded
  images, the rest show the mascot.
- Live trades, vault updates and payout rounds stream over the mock socket; buybacks fire when a coin
  trades at its floor.
- A "Demo Wallet (mock)" adapter appears in the wallet modal; it holds positions in 6 coins and "signs"
  trades locally (no RPC).
- The launch flow goes awaiting_deposit → deposit_received → creating → live in ~10s. Demo hooks: ticker
  `SLOW` never receives a deposit (shows expiry), ticker `FAIL` fails after the deposit and refunds.
