import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { ScoreRing } from '../components/ScoreRing';
import { SectionRow } from '../components/SectionRow';

interface ResumeResponse {
  forge_score: import('../lib/api').ForgeScoreDetail | null;
  last_apply: { job_title: string; company: string; timestamp: string } | null;
  resume: {
    name: string | null;
    headline: string | null;
    links: Record<string, string>;
    skills: Record<string, number>;
    experience_count: number;
    projects_count: number;
    summary_bullets: string[];
    updated_at: string | null;
    sections: string[] | null;
  } | null;
}

const ALL_SECTIONS = ['summary', 'experience', 'internships', 'education', 'projects', 'skills', 'certifications', 'achievements', 'activities'];

export function Resume() {
  const [data, setData] = useState<ResumeResponse | null>(null);

  useEffect(() => {
    api.get<ResumeResponse>('/resume').then(setData).catch(() => setData(null));
  }, []);

  if (!data) return <div style={{ padding: 16, color: 'var(--text-dim)' }}>Loading…</div>;

  const enabled = new Set(data.resume?.sections ?? ALL_SECTIONS);

  return (
    <div style={{ padding: 16 }}>
      <h1 style={{ fontSize: 20, marginBottom: 16 }}>Resume</h1>

      <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 20 }}>
        <ScoreRing score={data.forge_score?.overall_score ?? null} />
        <div>
          <div style={{ fontWeight: 600 }}>{data.resume?.name}</div>
          <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>{data.resume?.headline}</div>
          {data.last_apply && (
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
              Last applied: {data.last_apply.company} — {data.last_apply.job_title}
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16, marginBottom: 20, fontSize: 13, color: 'var(--text-dim)' }}>
        <span>{data.resume?.experience_count ?? 0} experience</span>
        <span>{data.resume?.projects_count ?? 0} projects</span>
        <span>{Object.keys(data.resume?.skills ?? {}).length} skill groups</span>
      </div>

      <h2 style={{ fontSize: 14, color: 'var(--text-dim)', marginBottom: 4 }}>Sections</h2>
      <div style={{ marginBottom: 20 }}>
        {ALL_SECTIONS.map((s) => <SectionRow key={s} label={s} enabled={enabled.has(s)} />)}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
        Edit sections via the bot chat ("sections: experience, education, skills") — coming to the app in v1.5.
      </div>
    </div>
  );
}
