# Holdfast brand

A *holdfast* is the root a kelp uses to grip a rock so waves cannot tear it away; "hold fast" means hold on
tight. The mark draws exactly that: **claws gripping a rock that rests on the floor, with an arrow rising out
of them.** Grip the floor, rise from it: the vault defends each coin's floor, and holders who hold on earn more.

## Files

| File | Use |
|---|---|
| `holdfast-mark.svg` | App icon / favicon / anywhere a square logo fits (mint tile, ink glyph). Used as `apps/web/src/app/icon.svg`. |
| `holdfast-logo.svg` | Horizontal logo for dark backgrounds (light wordmark). |
| `holdfast-logo-on-light.svg` | Horizontal logo for light backgrounds (dark wordmark). |
| `holdfast-wordmark.svg` | Wordmark alone (Geist Bold, outlined to paths: no font needed). |
| `holdfast-glyph-mint.svg` / `holdfast-glyph-ink.svg` | Glyph without the tile, for dark / light backgrounds. |
| `holdfast-avatar.svg` | Full-bleed square for profile pictures (X, Telegram, Discord): survives a circle crop. |
| `png/` | Exports: mark 512/1024, apple-touch-icon 180, avatar 400/1000, logos (dark, light, transparent), glyph, X header 1500×500. |

## Colours

| Token | Hex | Role |
|---|---|---|
| Mint (brand) | `#7ef0b8` | accents, glyph on dark |
| Tile gradient | `#9ff5cc` → `#3fd690` | the mark's background, top-left to bottom-right |
| Ink | `#04170e` | glyph on the mint tile, on light backgrounds |
| Night | `#07080c` | app background |
| Paper | `#eceef4` | wordmark on dark |

## Rules

- Clear space around the mark: at least a quarter of its width on every side.
- Smallest size: 16 px for the mark (favicon), 24 px tall for the horizontal logo.
- Keep the glyph ink on the mint tile, or mint / ink on its own. Don't recolour it, outline it, add shadows,
  stretch it, or put the mint tile on a mint background.
- The wordmark is always "Holdfast" (capital H, one word). The token is **$HOLD**.

## Regenerating

```bash
pip install fonttools && python3 brand/generate.py      # SVGs (outlines the wordmark from Geist Bold)
cd apps/web && cp ../../brand/export.mjs .brand-export.mjs && node .brand-export.mjs; rm .brand-export.mjs   # PNGs
```

The web app draws the same glyph in `apps/web/src/components/layout/Logo.tsx`; keep the paths in sync.
