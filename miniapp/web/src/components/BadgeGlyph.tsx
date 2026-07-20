export function BadgeGlyph({ badge, label }: { badge: string; label: string }) {
  if (!badge) return null;
  return (
    <span
      title={label}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontSize: 12, color: 'var(--text-dim)',
      }}
    >
      <span style={{ fontSize: 14 }}>{badge}</span>
      {label}
    </span>
  );
}
