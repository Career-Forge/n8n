import { useAppStore } from '../store/appStore';

export function Toast() {
  const toast = useAppStore((s) => s.toast);
  if (!toast) return null;
  return (
    <div style={{
      position: 'fixed', bottom: 76, left: '50%', transform: 'translateX(-50%)',
      background: 'var(--surface-2)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-sm)', padding: '8px 16px', fontSize: 13,
      boxShadow: '0 4px 16px rgba(0,0,0,0.3)', zIndex: 100,
    }}>
      {toast}
    </div>
  );
}
