import { useAppStore, Tab } from './store/appStore';
import { Home } from './screens/Home';
import { Jobs } from './screens/Jobs';
import { JobDetail } from './screens/JobDetail';
import { Tracker } from './screens/Tracker';
import { Resume } from './screens/Resume';
import { Settings } from './screens/Settings';
import { Toast } from './components/Toast';

const NAV: { key: Tab; icon: string; label: string }[] = [
  { key: 'home', icon: '🏠', label: 'Home' },
  { key: 'jobs', icon: '🔍', label: 'Jobs' },
  { key: 'tracker', icon: '📋', label: 'Tracker' },
  { key: 'resume', icon: '📄', label: 'Resume' },
];

export function App() {
  const { tab, setTab, selectedRank, selectRank } = useAppStore();

  let screen;
  if (tab === 'jobs' && selectedRank !== null) {
    screen = <JobDetail rank={selectedRank} />;
  } else {
    screen = {
      home: <Home />,
      jobs: <Jobs />,
      tracker: <Tracker />,
      resume: <Resume />,
      settings: <Settings />,
    }[tab];
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ flex: 1, overflowY: 'auto' }}>{screen}</div>

      <nav style={{
        display: 'flex', borderTop: '1px solid var(--border)', background: 'var(--surface)',
        paddingBottom: 'env(safe-area-inset-bottom, 0)',
      }}>
        {NAV.map((item) => (
          <button
            key={item.key}
            onClick={() => { setTab(item.key); if (item.key !== 'jobs') selectRank(null); }}
            style={{
              flex: 1, background: 'none', border: 'none', padding: '10px 0',
              color: tab === item.key ? 'var(--accent)' : 'var(--text-dim)',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, fontSize: 11,
            }}
          >
            <span style={{ fontSize: 18 }}>{item.icon}</span>
            {item.label}
          </button>
        ))}
        <button
          onClick={() => setTab('settings')}
          style={{
            flex: 1, background: 'none', border: 'none', padding: '10px 0',
            color: tab === 'settings' ? 'var(--accent)' : 'var(--text-dim)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, fontSize: 11,
          }}
        >
          <span style={{ fontSize: 18 }}>⚙️</span>
          Settings
        </button>
      </nav>

      <Toast />
    </div>
  );
}
