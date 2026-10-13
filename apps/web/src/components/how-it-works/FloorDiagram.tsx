/** Illustration: price sets ATHs, the floor steps up behind it, and the vault buys ("V") at the floor. */
export function FloorDiagram({ className }: { className?: string }) {
  const price = "M6 74 L30 62 L46 66 L66 44 L84 50 L104 28 L122 24 L140 40 L158 52 L176 61 L190 57 L206 48 L226 38 L248 30";
  const floor = "M6 78 L46 78 L46 70 L66 70 L66 58 L104 58 L104 44 L122 44 L122 41 L248 41";
  return (
    <svg viewBox="0 0 290 96" className={className} role="img" aria-label="The floor follows the ATH and the vault buys at the floor">
      <line x1="122" x2="248" y1="24" y2="24" stroke="var(--color-ath)" strokeDasharray="3 4" opacity="0.7" />
      <text x="254" y="27" fill="var(--color-ath)" fontSize="10" fontWeight="600">
        ATH
      </text>
      <path d={floor} stroke="var(--color-floor)" strokeWidth="2" fill="none" />
      <text x="254" y="44" fill="var(--color-floor)" fontSize="10" fontWeight="600">
        Floor
      </text>
      <path d={price} stroke="var(--color-fg)" strokeWidth="2" fill="none" strokeLinejoin="round" />
      <g>
        <circle cx="176" cy="61" r="8" fill="var(--color-vault)" opacity="0.18" />
        <text x="176" y="84" fill="var(--color-vault)" fontSize="11" fontWeight="700" textAnchor="middle">
          V
        </text>
        <path d="M176 74 L176 66" stroke="var(--color-vault)" strokeWidth="1.5" />
      </g>
    </svg>
  );
}
