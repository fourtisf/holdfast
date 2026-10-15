# Promo videos

| File | Length | What |
|---|---|---|
| `moatpad-review.mp4` | 45 s | Feature review: the problem, the moat, floor vault and buybacks, holder payouts every 2 minutes, the 40/25/15/10/10 split, no withdraw path and verifiable rounds, the app, launching for 0.015 SOL |
| `moatpad-live.mp4` | 17 s | "The moat is open", 3-2-1, MOATPAD IS LIVE, the fee split, call to action (post it once launches are open) |

Both are 1920×1080, 30 fps, H.264, silent (X autoplays muted; add a music bed in an editor if wanted).

`ad.html` draws every frame as a pure function of time (`window.render(t)`), so renders are reproducible.
`ui/` holds screenshots of the web app in mock mode (`NEXT_PUBLIC_USE_MOCKS=1`, the "MOCK DATA" badge hidden).

```bash
cd apps/web && cp ../../brand/video/render.mjs .render.mjs
node .render.mjs review ../../brand/video/moatpad-review.mp4
node .render.mjs live ../../brand/video/moatpad-live.mp4
node .render.mjs review --stills 3,16,30     # stills next to ad.html to check a change
rm .render.mjs
```
