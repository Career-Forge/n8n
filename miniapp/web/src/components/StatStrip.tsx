export function StatStrip({ counts }: { counts: Record<string, number> }) {
  const applied = counts.applied ?? 0;
  const interviewing = counts.interviewing ?? 0;
  const saved = counts.saved ?? 0;

  return (
    <div style={{ fontSize: 14, color: 'var(--text-dim)', marginBottom: 16 }}>
      <span style={{ color: 'var(--text)' }}>{applied}</span> applied ·{' '}
      <span style={{ color: 'var(--text)' }}>{interviewing}</span> interviewing ·{' '}
      <span style={{ color: 'var(--text)' }}>{saved}</span> saved this week
    </div>
  );
}
