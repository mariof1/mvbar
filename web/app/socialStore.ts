'use client';

import { create } from 'zustand';
import { getSocialSummary } from './apiClient';

type SocialUpdateState = {
  unreadShares: number;
  incomingRequests: number;
  lastUpdate: number;
  setCounts: (unreadShares: number, incomingRequests: number) => void;
  trigger: () => void;
  refresh: (token: string | null) => Promise<void>;
};

let refreshGeneration = 0;

export const useSocialUpdates = create<SocialUpdateState>((set) => ({
  unreadShares: 0,
  incomingRequests: 0,
  lastUpdate: 0,
  setCounts: (unreadShares, incomingRequests) => {
    ++refreshGeneration;
    set({ unreadShares, incomingRequests });
  },
  trigger: () => set({ lastUpdate: Date.now() }),
  refresh: async (token) => {
    const request = ++refreshGeneration;
    if (!token) {
      set({ unreadShares: 0, incomingRequests: 0 });
      return;
    }
    try {
      const summary = await getSocialSummary(token);
      if (request !== refreshGeneration) return;
      set({
        unreadShares: summary.unreadShares,
        incomingRequests: summary.incoming.length,
      });
    } catch {
      // A later WebSocket event or page visit will retry the summary.
    }
  },
}));
