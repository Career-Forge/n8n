export function DimensionBar({ label, value }: { label: string; value: number }) {
  const pct = Math.max(0, Math.min(100, (value / 10) * 100));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
      <div style={{ flex: '0 0 130px', color: 'var(--text-dim)' }}>{label}</div>
      <div style={{ flex: 1, height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)' }} />
      </div>
      <div style={{ flex: '0 0 24px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );
}
