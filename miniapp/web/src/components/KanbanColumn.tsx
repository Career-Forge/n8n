import { ReactNode } from 'react';

export function KanbanColumn({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <div style={{
      flex: '0 0 78%', scrollSnapAlign: 'start', background: 'var(--surface-2)',
      borderRadius: 'var(--radius)', padding: 10, minHeight: 200,
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: 'var(--text-dim)' }}>
        {title} <span style={{ color: 'var(--text)' }}>{count}</span>
      </div>
      {children}
    </div>
  );
}
