import { useEffect, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { api, ApiError, JobItem } from '../lib/api';
import { ScoreRing } from '../components/ScoreRing';
import { DimensionBar } from '../components/DimensionBar';
import { BadgeGlyph } from '../components/BadgeGlyph';
import { haptic } from '../lib/telegram';

const DIMENSION_LABELS: Record<string, string> = {
  skills_match: 'Skills match',
  experience_relevance: 'Experience',
  metric_impact: 'Metric impact',
  seniority_fit: 'Seniority fit',
  keyword_coverage: 'Keyword coverage',
  leadership_signals: 'Leadership',
};

export function JobDetail({ rank }: { rank: number }) {
  const { selectRank, showToast, loadSnapshot, loadApplications } = useAppStore();
  const [job, setJob] = useState<JobItem | null>(null);
  const [forgeScore, setForgeScore] = useState<import('../lib/api').ForgeScoreDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api.get<JobItem & { forge_score: import('../lib/api').ForgeScoreDetail | null }>(`/jobs/${rank}`)
      .then((j) => { setJob(j); setForgeScore(j.forge_score); })
      .catch(() => showToast('Could not load that job'));
  }, [rank, showToast]);

  if (!job) return <div style={{ padding: 16, color: 'var(--text-dim)' }}>Loading…</div>;

  const status = job.application?.status ?? null;

  async function runAction(kind: 'apply' | 'mark-applied' | 'find') {
    setBusy(kind);
    try {
      if (kind === 'apply') {
        await api.post('/actions/apply', { rank });
        haptic('medium');
        showToast('Sent to the bot — check your Telegram chat');
      } else if (kind === 'mark-applied') {
        await api.post('/applications/mark-applied', { rank });
        haptic('light');
        showToast('Marked as applied');
        await loadApplications();
        const refreshed = await api.get<JobItem>(`/jobs/${rank}`);
        setJob(refreshed);
      }
    } catch (e) {
      showToast(e instanceof ApiError ? `Error: ${JSON.stringify(e.body)}` : 'Something went wrong');
    } finally {
      setBusy(null);
      loadSnapshot();
    }
  }

  return (
    <div style={{ padding: 16 }}>
      <button onClick={() => selectRank(null)} style={{ background: 'none', border: 'none', color: 'var(--accent)', marginBottom: 12, padding: 0 }}>
        ← Back
      </button>

      <h1 style={{ fontSize: 20, marginBottom: 2 }}>{job.company}</h1>
      <div style={{ color: 'var(--text-dim)', marginBottom: 4 }}>{job.title}</div>
      <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 8 }}>{job.location}</div>
      <BadgeGlyph badge={job.badge} label={job.badge_label} />

      <div style={{ margin: '16px 0', padding: 12, background: 'var(--surface)', borderRadius: 'var(--radius-sm)' }}>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 6 }}>Job description</div>
        <div style={{ fontSize: 13 }}>{job.description_snippet}</div>
      </div>

      {forgeScore && (
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', margin: '16px 0', padding: 12, background: 'var(--surface)', borderRadius: 'var(--radius-sm)' }}>
          <ScoreRing score={forgeScore.overall_score} size={80} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {Object.entries(forgeScore.dimensions).map(([k, v]) => (
              <DimensionBar key={k} label={DIMENSION_LABELS[k] ?? k} value={v} />
            ))}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
        {job.url && (
          <a href={job.url} target="_blank" rel="noreferrer" style={{
            textAlign: 'center', padding: 12, borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border)', color: 'var(--text)', textDecoration: 'none', fontSize: 14,
          }}>
            View posting ↗
          </a>
        )}
        <ActionButton
          label={status ? 'Update status in Tracker' : 'Generate resume + apply'}
          primary
          busy={busy === 'apply'}
          onClick={() => runAction('apply')}
        />
        {!status && (
          <ActionButton
            label="Mark applied (already applied elsewhere)"
            busy={busy === 'mark-applied'}
            onClick={() => runAction('mark-applied')}
          />
        )}
      </div>
    </div>
  );
}

function ActionButton({ label, primary, busy, onClick }: { label: string; primary?: boolean; busy?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      style={{
        padding: 12, borderRadius: 'var(--radius-sm)', fontSize: 14, fontWeight: 600,
        border: primary ? 'none' : '1px solid var(--border)',
        background: primary ? 'var(--accent)' : 'transparent',
        color: primary ? '#fff' : 'var(--text)',
        opacity: busy ? 0.6 : 1,
      }}
    >
      {busy ? 'Working…' : label}
    </button>
  );
}
