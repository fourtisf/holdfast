# Promo videos

| File | Length | What |
|---|---|---|
| `moatpad-tour.mp4` | 60 s, music | Website tour on the real UI: home, a coin card, the coin page (floor and ATH on the chart, the floor vault and its split, trading), holder payouts with a live countdown that pays out on screen, launching a coin (typing, choosing the floor, dev buy, one-transaction launch), leaderboard, how it works |
| `moatpad-review.mp4` | 45 s, silent | Feature review: the problem, the moat, floor vault and buybacks, holder payouts every 2 minutes, the 40/25/15/10/10 split, no withdraw path and verifiable rounds, the app, launching for 0.015 SOL |
| `moatpad-live.mp4` | 24 s, music | Cinematic announcement: "The moat is open", a vault-dial 3-2-1, the drop on MOATPAD IS LIVE, four feature hits on the real UI, the fee split, call to action with X and Telegram (post it once launches are open) |

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
python3 brand/video/music.py                       # music-tour.wav, music-live.wav

# re-capture the UI (only when the web app changed): mock build on :3311
cd apps/web
NEXT_PUBLIC_USE_MOCKS=1 NEXT_PUBLIC_SOLANA_CLUSTER=mainnet-beta pnpm build && NEXT_PUBLIC_USE_MOCKS=1 pnpm start -p 3311 &
cp ../../brand/video/capture-tour.mjs .capture.mjs && node .capture.mjs && rm .capture.mjs

# render
cp ../../brand/video/render.mjs .render.mjs
node .render.mjs tour ../../brand/video/moatpad-tour.mp4
node .render.mjs live ../../brand/video/moatpad-live.mp4
node .render.mjs review ../../brand/video/moatpad-review.mp4
node .render.mjs tour --stills 12,24,45     # stills next to the HTML to check a change
rm .render.mjs
```
