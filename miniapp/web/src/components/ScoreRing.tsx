export function ScoreRing({ score, size = 96 }: { score: number | null; size?: number }) {
  const pct = score === null ? 0 : Math.max(0, Math.min(100, (score / 10) * 100));
  const r = (size - 10) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - pct / 100);
  const color = pct >= 70 ? 'var(--ok)' : pct >= 45 ? 'var(--warn)' : 'var(--bad)';
  const label = pct >= 70 ? 'Great' : pct >= 45 ? 'Fair' : 'Low';

  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--border)" strokeWidth={8} fill="none" />
        <circle
          cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={8} fill="none"
          strokeDasharray={c} strokeDashoffset={offset} strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.4s ease' }}
        />
      </svg>
      <div style={{
        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
      }}>
        <div style={{ fontSize: size * 0.28, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
          {score === null ? '—' : Math.round(score * 10)}
        </div>
        {score !== null && <div style={{ fontSize: 11, color }}>{label}</div>}
      </div>
    </div>
  );
}
