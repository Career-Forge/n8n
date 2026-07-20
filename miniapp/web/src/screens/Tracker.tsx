import { useEffect, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { KanbanColumn } from '../components/KanbanColumn';
import { AppCard } from '../components/AppCard';
import { api, ApplicationRow } from '../lib/api';

const COLUMNS: { key: ApplicationRow['status']; label: string }[] = [
  { key: 'saved', label: 'Saved' },
  { key: 'applied', label: 'Applied' },
  { key: 'interviewing', label: 'Interviewing' },
  { key: 'offer', label: 'Offer' },
  { key: 'rejected', label: 'Rejected' },
];

export function Tracker() {
  const { applications, loadApplications, showToast } = useAppStore();
  const [logOpen, setLogOpen] = useState(false);

  useEffect(() => {
    loadApplications();
  }, [loadApplications]);

  const items = applications?.items ?? [];

  async function cycleStatus(row: ApplicationRow) {
    const idx = COLUMNS.findIndex((c) => c.key === row.status);
    const next = COLUMNS[(idx + 1) % COLUMNS.length].key;
    try {
      await api.patch(`/applications/${row.id}`, { status: next });
      showToast(`Moved to ${next}`);
      loadApplications();
    } catch {
      showToast('Could not update status');
    }
  }

  return (
    <div style={{ padding: '16px 0 16px 16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingRight: 16, marginBottom: 12 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Tracker</h1>
        <button
          onClick={() => setLogOpen(true)}
          style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', padding: '6px 12px', fontSize: 13 }}
        >
          + Log
        </button>
      </div>

      <div style={{ display: 'flex', gap: 10, overflowX: 'auto', scrollSnapType: 'x mandatory', paddingRight: 16, paddingBottom: 8 }}>
        {COLUMNS.map((col) => (
          <KanbanColumn key={col.key} title={col.label} count={items.filter((i) => i.status === col.key).length}>
            {items.filter((i) => i.status === col.key).map((row) => (
              <AppCard key={row.id} row={row} onClick={() => cycleStatus(row)} />
            ))}
          </KanbanColumn>
        ))}
      </div>

      {logOpen && <LogApplicationSheet onClose={() => setLogOpen(false)} onSaved={() => { setLogOpen(false); loadApplications(); }} />}
    </div>
  );
}

function LogApplicationSheet({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [jobTitle, setJobTitle] = useState('');
  const [company, setCompany] = useState('');
  const [url, setUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!jobTitle || !company) { setError('Title and company are required'); return; }
    setSaving(true);
    setError(null);
    try {
      await api.post('/applications', { job_title: jobTitle, company, url: url || undefined, status: 'applied' });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'flex-end', zIndex: 50,
    }} onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--surface)', width: '100%', borderRadius: '16px 16px 0 0', padding: 20 }}
      >
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Log an application</h2>
        <Input placeholder="Job title" value={jobTitle} onChange={setJobTitle} />
        <Input placeholder="Company" value={company} onChange={setCompany} />
        <Input placeholder="Link (optional)" value={url} onChange={setUrl} />
        {error && <div style={{ color: 'var(--bad)', fontSize: 12, marginBottom: 8 }}>{error}</div>}
        <button
          onClick={save}
          disabled={saving}
          style={{ width: '100%', padding: 12, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', fontWeight: 600 }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function Input({ placeholder, value, onChange }: { placeholder: string; value: string; onChange: (v: string) => void }) {
  return (
    <input
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width: '100%', padding: 10, marginBottom: 8, background: 'var(--surface-2)',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)', fontSize: 14,
      }}
    />
  );
}
