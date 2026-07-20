import { ApplicationRow } from '../lib/api';

function daysAgo(iso: string | null): string {
  if (!iso) return '';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return 'today';
  return `${days}d ago`;
}

export function AppCard({ row, onClick }: { row: ApplicationRow; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)', padding: 10, marginBottom: 8, cursor: 'pointer',
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 13 }}>{row.company}</div>
      <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{row.job_title}</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 11, color: 'var(--text-dim)' }}>
        <span>{row.forge_score !== null ? `${Math.round(row.forge_score * 10)}%` : ''}</span>
        <span>{daysAgo(row.applied_at || row.updated_at)}</span>
      </div>
    </div>
  );
}
