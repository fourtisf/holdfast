import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { fetchCoinForPreview } from "@/lib/server-coin";
import { formatMarketCap, formatSol } from "@/lib/format";

export const alt = "Moatpad coin";

// The brand logo, read from public/ (the server's working directory is the web app).
function loadLogo(): string {
  try {
    return `data:image/svg+xml;base64,${readFileSync(join(process.cwd(), "public/brand/moatpad-logo.svg")).toString("base64")}`;
  } catch {
    return "";
  }
}
const LOGO = loadLogo();
const LOGO_WIDTH = 209; // 48 px tall at the logo's 4.35 : 1 aspect
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const C = { bg: "#0a0b0e", surface: "#111216", line: "#26272e", fg: "#f3efe4", muted: "#a19d92", brand: "#e8bc5b", floor: "#6aa6ff", payout: "#f2c76a" };

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
          <img src={LOGO} height={48} width={LOGO_WIDTH} alt="" />
          <div style={{ fontSize: 26, color: C.muted }}>Every coin gets a moat</div>
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
