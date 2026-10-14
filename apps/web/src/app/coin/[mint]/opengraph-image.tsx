import { ImageResponse } from "next/og";
import { logoGlyph } from "@/components/layout/Logo";
import { fetchCoinForPreview } from "@/lib/server-coin";
import { formatMarketCap, formatSol } from "@/lib/format";

export const alt = "Holdfast coin";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const C = { bg: "#07080c", surface: "#0e1016", line: "#222734", fg: "#eceef4", muted: "#949bad", brand: "#7ef0b8", floor: "#ffb547", payout: "#ffd95e" };

function Metric({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", padding: "22px 24px", borderRadius: 22, background: C.surface, border: `2px solid ${C.line}`, flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 20, color: C.muted, textTransform: "uppercase", letterSpacing: 1, whiteSpace: "nowrap" }}>{label}</div>
      <div style={{ fontSize: 38, fontWeight: 700, color, marginTop: 8, whiteSpace: "nowrap" }}>{value}</div>
    </div>
  );
}

/** Share card for a coin page: market cap, floor and what it paid holders. */
export default async function Image({ params }: { params: Promise<{ mint: string }> }) {
  const { mint } = await params;
  const coin = await fetchCoinForPreview(decodeURIComponent(mint));
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: C.bg, color: C.fg, padding: 60, fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 30, fontWeight: 700, color: C.brand }}>
            <svg width="44" height="44" viewBox="0 0 64 64">
              <rect width="64" height="64" rx="16" fill={C.brand} />
              {logoGlyph()}
            </svg>
            Holdfast
          </div>
          <div style={{ fontSize: 26, color: C.muted }}>0% to the dev · vault defends the floor</div>
        </div>
        {coin ? (
          <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
              <div style={{ width: 120, height: 120, borderRadius: 30, background: C.surface, border: `3px solid ${C.line}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 60, fontWeight: 700, color: C.brand }}>
                {coin.ticker.slice(0, 1)}
              </div>
              <div style={{ display: "flex", flexDirection: "column" }}>
                <div style={{ display: "flex", fontSize: 72, fontWeight: 800, lineHeight: 1.05 }}>{coin.name.slice(0, 28)}</div>
                <div style={{ display: "flex", fontSize: 38, color: C.muted, marginTop: 6 }}>
                  {`$${coin.ticker} · ${coin.graduated ? "PumpSwap" : `bonding curve ${Math.floor(coin.bondingCurveProgress * 100)}%`}`}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 20, marginTop: 48 }}>
              <Metric label="Market cap" value={formatMarketCap(coin.marketCapSol)} color={C.fg} />
              <Metric label="Floor" value={formatMarketCap(coin.floorMarketCapSol)} color={C.floor} />
              <Metric label="Vault" value={formatSol(coin.vault.floorSol)} color={C.floor} />
              <Metric label="Paid to holders" value={formatSol(coin.paidOutSol)} color={C.payout} />
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "center" }}>
            <div style={{ fontSize: 80, fontWeight: 800 }}>Memecoins that defend their floor</div>
            <div style={{ fontSize: 36, color: C.muted, marginTop: 20 }}>Creator fees fill a vault that buys back at the floor and pays holders every 2 minutes.</div>
          </div>
        )}
      </div>
    ),
    size,
  );
}
