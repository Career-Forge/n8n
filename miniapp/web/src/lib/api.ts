import { getInitData } from './telegram';

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super(`API error ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Tg-Init-Data': getInitData(),
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    let body: unknown = null;
    try { body = await res.json(); } catch { /* no body */ }
    throw new ApiError(res.status, body);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body !== undefined ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

// ── Response shapes (mirrors miniapp/api/app/routers/*.py) ──────────────
export interface JobItem {
  rank: number;
  job_id: string | null;
  title: string | null;
  company: string | null;
  location: string | null;
  url: string | null;
  fit_score: number | null;
  score100: number | null;
  match_pct: number | null;
  description_snippet: string | null;
  source: string | null;
  source_tier: number | null;
  badge: string;
  badge_label: string;
  application: { id: number; status: string } | null;
}

export interface ForgeScoreDetail {
  overall_score: number;
  dimensions: {
    skills_match: number;
    experience_relevance: number;
    metric_impact: number;
    seniority_fit: number;
    keyword_coverage: number;
    leadership_signals: number;
  };
  gaps: string[];
  strengths: string[];
  recommendation: string;
  keyword_gaps: string[];
  keyword_hits: string[];
  visa_flag: boolean;
}

export interface SnapshotResponse {
  generated_at: string | null;
  user_prefs: Record<string, unknown> | null;
  last_jobs: JobItem[];
  last_jobs_created_at: string | null;
  last_jobs_expired: boolean;
  last_jobs_age_seconds: number | null;
  tracked_applications: unknown[];
  last_apply: {
    job_id: string; job_title: string; company: string; location: string;
    url: string | null; forge_score: ForgeScoreDetail | null;
    seniority_mode: string | null; timestamp: string | null;
  } | null;
  last_search_intent: unknown;
}

export interface ApplicationRow {
  id: number;
  job_id: string | null;
  url: string | null;
  url_norm: string | null;
  job_title: string;
  company: string;
  location: string | null;
  source: string;
  status: 'saved' | 'applied' | 'interviewing' | 'offer' | 'rejected';
  forge_score: number | null;
  score_detail: ForgeScoreDetail | null;
  notes: string | null;
  status_history: { from: string | null; to: string; at: string; via: string }[];
  applied_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApplicationsListResponse {
  items: ApplicationRow[];
  counts: Record<string, number>;
}
