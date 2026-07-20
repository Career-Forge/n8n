import { useEffect } from 'react';
import { useAppStore } from '../store/appStore';
import { StatStrip } from '../components/StatStrip';

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function Home() {
  const { applications, loadApplications, snapshot, loadSnapshot, setTab } = useAppStore();

  useEffect(() => {
    loadApplications();
    loadSnapshot();
  }, [loadApplications, loadSnapshot]);

  const counts = applications?.counts ?? { saved: 0, applied: 0, interviewing: 0, offer: 0, rejected: 0 };
  const recent = (applications?.items ?? []).slice(0, 5);

  return (
    <div style={{ padding: 16 }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Welcome back 👋</h1>
      <StatStrip counts={counts} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 20 }}>
        <QuickAction label="🔍 Find Jobs" onClick={() => setTab('jobs')} />
        <QuickAction label="📋 Tracker" onClick={() => setTab('tracker')} />
        <QuickAction label="📄 Resume" onClick={() => setTab('resume')} />
        <QuickAction label="⚙️ Settings" onClick={() => setTab('settings')} />
      </div>

      {snapshot?.last_jobs_expired === false && (
        <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 12 }}>
          {snapshot.last_jobs.length} jobs from your last digest
        </div>
      )}

      <h2 style={{ fontSize: 14, color: 'var(--text-dim)', marginBottom: 8 }}>Recent activity</h2>
      {recent.length === 0 && <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>Nothing tracked yet.</div>}
      {recent.map((r) => (
        <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
          <span>{r.company} — <span className={`status-${r.status}`}>{r.status}</span></span>
          <span style={{ color: 'var(--text-dim)' }}>{fmtTime(r.updated_at)}</span>
        </div>
      ))}
    </div>
  );
}

function QuickAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)', padding: '14px 8px', color: 'var(--text)',
        fontSize: 14, fontWeight: 600,
      }}
    >
      {label}
    </button>
  );
}
