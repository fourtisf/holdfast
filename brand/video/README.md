# Promo videos

| File | Length | What |
|---|---|---|
| `moatpad-tour.mp4` | 60 s, music | Website tour on the real UI: home, a coin card, the coin page (floor and ATH on the chart, the floor vault and its split, trading), holder payouts with a live countdown that pays out on screen, launching a coin (typing, choosing the floor, dev buy, one-transaction launch), leaderboard, how it works |
| `moatpad-review.mp4` | 45 s, silent | Feature review: the problem, the moat, floor vault and buybacks, holder payouts every 2 minutes, the 40/25/15/10/10 split, no withdraw path and verifiable rounds, the app, launching for 0.015 SOL |
| `moatpad-live.mp4` | 63 s, music | Launch demo on the real UI: connecting the wallet (the creator wallet fills itself in), name and ticker, choosing the floor, dev buy, confirming in the wallet, the coin going live, then a time-lapse of it trading: the floor rising with the ATH, the vault filling, a buyback at the floor and holder payouts; ends with what makes Moatpad different. Built by `build-demo.sh` |

| `moatpad-burn.mp4` | 32 s, music | "Buy & burn $MOATPAD" feature: every trade on every Moatpad coin pays a creator fee into the coin's vault, the 40/25/15/10/10 split with the 10% burn share catching fire, the vault buying $MOATPAD on pump.fun / PumpSwap and burning it, the launches → trading → fees → burn flywheel, and an outro with the CA. `burn.html`, music `music.py burn` |
| `moatpad-bot.mp4` | 40 s, music | "Moatpad Bot · coming soon" teaser: a phone runs the bot's real copy next to the captions: `/launch` asked one question at a time (name, ticker, photo, floor and dev buy buttons), one payment with the QR on moatpad.fun and "$MDOG is LIVE!", the `/buybot` buy alerts in a community group, payout, floor-defence, graduation and burn notifications on the lock screen, the "/" command menu with `/trending` and `/burns`, the coin page's Telegram card opening the bot, and a COMING SOON outro. `bot.html`, music `music.py bot` |

All are 1920×1080, 30 fps, H.264 (AAC audio at −14 LUFS where there is music).

- `tour.html`, `live.html` and `ad.html` draw every frame as a pure function of time (`window.render(t)`), so renders
  are reproducible.
- `tour/` holds the screenshots the tour flies over, captured by `capture-tour.mjs` from the web app in mock mode with the
  "MOCK DATA" badge hidden. `ui/` holds the screenshots used by `ad.html`.
- `music.py` synthesizes the soundtracks from scratch (numpy only, no samples): `music-tour.wav` (100 BPM, cuts on its
  2.4 s bars, impacts at 4.8, 43.2 and 52.8 s) and `music-live.wav` (120 BPM: countdown hits at 4, 5 and 6 s, the
  drop at 8 s on "MOATPAD IS LIVE"). The WAVs are
  generated, not committed; `render.mjs` muxes `music-<video>.wav` in when it exists.

```bash
python3 brand/video/music.py                       # music-tour.wav, music-live.wav, music-burn.wav, music-bot.wav
python3 brand/video/music.py burn                  # just one of them

# re-capture the UI (only when the web app changed): mock build on :3311
cd apps/web
NEXT_PUBLIC_USE_MOCKS=1 NEXT_PUBLIC_SOLANA_CLUSTER=mainnet-beta pnpm build && NEXT_PUBLIC_USE_MOCKS=1 pnpm start -p 3311 &
cp ../../brand/video/capture-tour.mjs .capture.mjs && node .capture.mjs && rm .capture.mjs

# render
cp ../../brand/video/render.mjs .render.mjs
node .render.mjs tour ../../brand/video/moatpad-tour.mp4
node .render.mjs live ../../brand/video/moatpad-live.mp4
node .render.mjs review ../../brand/video/moatpad-review.mp4
node .render.mjs burn ../../brand/video/moatpad-burn.mp4
node .render.mjs bot ../../brand/video/moatpad-bot.mp4
node .render.mjs tour --stills 12,24,45     # stills next to the HTML to check a change
rm .render.mjs
```
