import { useEffect, useState } from 'react';
import { api } from '../lib/api';

interface SettingsResponse {
  prefs: Record<string, unknown>;
  timezone: string | null;
  schedule_times: string[] | null;
}

export function Settings() {
  const [data, setData] = useState<SettingsResponse | null>(null);

  useEffect(() => {
    api.get<SettingsResponse>('/settings').then(setData).catch(() => setData(null));
  }, []);

  if (!data) return <div style={{ padding: 16, color: 'var(--text-dim)' }}>Loading…</div>;

  const entries = Object.entries(data.prefs);

  return (
    <div style={{ padding: 16 }}>
      <h1 style={{ fontSize: 20, marginBottom: 16 }}>Settings</h1>

      {entries.length === 0 && (
        <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>
          No preferences set yet. Try "remember I'm in NYC" or "always remote only" in the bot chat.
        </div>
      )}

      {entries.map(([key, value]) => (
        <div key={key} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', textTransform: 'capitalize' }}>{key.replace(/_/g, ' ')}</div>
          <div style={{ fontSize: 14 }}>{JSON.stringify(value)}</div>
        </div>
      ))}

      <div style={{ marginTop: 20, fontSize: 12, color: 'var(--text-dim)' }}>
        Editing prefs from the app is coming in v1.5 — for now, reply to the bot with "prefs: ..." or "remember ...".
      </div>
    </div>
  );
}
