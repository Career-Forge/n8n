export function MatchPill({ pct }: { pct: number | null }) {
  if (pct === null) return <span style={{ color: 'var(--text-dim)' }}>—</span>;
  const color = pct >= 80 ? 'var(--ok)' : pct >= 60 ? 'var(--warn)' : 'var(--text-dim)';
  return (
    <span style={{ color, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
      {pct}%
    </span>
  );
}
