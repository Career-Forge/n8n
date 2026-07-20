export function SectionRow({ label, enabled }: { label: string; enabled: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', fontSize: 13, textTransform: 'capitalize' }}>
      <span style={{ color: enabled ? 'var(--ok)' : 'var(--text-dim)' }}>{enabled ? '✅' : '⬜'}</span>
      {label}
    </div>
  );
}
