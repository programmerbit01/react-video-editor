import { create } from "zustand";

interface VappMediaState {
  page: number;
  hasMore: boolean;
  loadingMore: boolean;
  setPage: (page: number) => void;
  setHasMore: (hasMore: boolean) => void;
  setLoadingMore: (v: boolean) => void;
}

export const useVappMediaStore = create<VappMediaState>((set) => ({
  page: 1,
  hasMore: false,
  loadingMore: false,
  setPage: (page) => set({ page }),
  setHasMore: (hasMore) => set({ hasMore }),
  setLoadingMore: (loadingMore) => set({ loadingMore }),
}));
