import { create } from 'zustand';
import { api, ApplicationsListResponse, SnapshotResponse } from '../lib/api';

export type Tab = 'home' | 'jobs' | 'tracker' | 'resume' | 'settings';

interface AppState {
  tab: Tab;
  setTab: (tab: Tab) => void;

  snapshot: SnapshotResponse | null;
  snapshotLoading: boolean;
  snapshotError: string | null;
  loadSnapshot: () => Promise<void>;

  applications: ApplicationsListResponse | null;
  applicationsLoading: boolean;
  loadApplications: () => Promise<void>;

  selectedRank: number | null;
  selectRank: (rank: number | null) => void;

  toast: string | null;
  showToast: (msg: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  tab: 'home',
  setTab: (tab) => set({ tab }),

  snapshot: null,
  snapshotLoading: false,
  snapshotError: null,
  loadSnapshot: async () => {
    set({ snapshotLoading: true, snapshotError: null });
    try {
      const snapshot = await api.get<SnapshotResponse>('/snapshot');
      set({ snapshot, snapshotLoading: false });
    } catch (e) {
      set({ snapshotLoading: false, snapshotError: e instanceof Error ? e.message : 'failed to load' });
    }
  },

  applications: null,
  applicationsLoading: false,
  loadApplications: async () => {
    set({ applicationsLoading: true });
    try {
      const applications = await api.get<ApplicationsListResponse>('/applications');
      set({ applications, applicationsLoading: false });
    } catch {
      set({ applicationsLoading: false });
    }
  },

  selectedRank: null,
  selectRank: (rank) => set({ selectedRank: rank }),

  toast: null,
  showToast: (msg) => {
    set({ toast: msg });
    setTimeout(() => set((s) => (s.toast === msg ? { toast: null } : s)), 2500);
  },
}));
