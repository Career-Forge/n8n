import { JobItem } from '../lib/api';
import { BadgeGlyph } from './BadgeGlyph';
import { MatchPill } from './MatchPill';

const STATUS_LABEL: Record<string, string> = {
  saved: 'Saved', applied: 'Applied', interviewing: 'Interviewing',
  offer: 'Offer', rejected: 'Rejected',
};

export function JobCard({ job, onClick }: { job: JobItem; onClick: () => void }) {
  const status = job.application?.status ?? null;
  return (
    <div
      onClick={onClick}
      className={status ? `status-border-${status}` : ''}
      style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderLeft: `3px solid ${status ? '' : 'var(--border)'}`,
        borderRadius: 'var(--radius-sm)', padding: 12, marginBottom: 8, cursor: 'pointer',
        display: 'flex', flexDirection: 'column', gap: 4,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div style={{ fontWeight: 600 }}>{job.company}</div>
        <MatchPill pct={job.match_pct} />
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>{job.title}</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
        <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{job.location || 'Location unknown'}</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <BadgeGlyph badge={job.badge} label={job.badge_label} />
          {status && <span className={`status-${status}`} style={{ fontSize: 12 }}>{STATUS_LABEL[status]}</span>}
        </div>
      </div>
    </div>
  );
}
