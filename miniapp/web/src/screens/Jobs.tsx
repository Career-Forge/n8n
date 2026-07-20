import { useEffect } from 'react';
import { useAppStore } from '../store/appStore';
import { JobCard } from '../components/JobCard';

export function Jobs() {
  const { snapshot, snapshotLoading, snapshotError, loadSnapshot, selectRank } = useAppStore();

  useEffect(() => {
    loadSnapshot();
  }, [loadSnapshot]);

  return (
    <div style={{ padding: 16 }}>
      <h1 style={{ fontSize: 20, marginBottom: 12 }}>Jobs</h1>

      {snapshotLoading && <div style={{ color: 'var(--text-dim)' }}>Loading…</div>}
      {snapshotError && <div style={{ color: 'var(--bad)' }}>{snapshotError}</div>}

      {snapshot?.last_jobs_expired && (
        <div style={{
          background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)', padding: 12,
          marginBottom: 12, fontSize: 13, color: 'var(--text-dim)',
        }}>
          This digest has expired. Send a new search in the bot chat, or run one from Home.
        </div>
      )}

      {snapshot?.last_jobs.length === 0 && !snapshotLoading && (
        <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>No jobs yet — search for something in the bot chat.</div>
      )}

      {snapshot?.last_jobs.map((job) => (
        <JobCard key={job.rank} job={job} onClick={() => selectRank(job.rank)} />
      ))}
    </div>
  );
}
