import { create } from "zustand";
import { persist } from "zustand/middleware";

export type GlobalAnimationType = "none" | "quickFade";

interface GlobalAnimationStore {
  type: GlobalAnimationType;
  setType: (type: GlobalAnimationType) => void;
}

const useGlobalAnimationStore = create<GlobalAnimationStore>()(
  persist(
    (set) => ({
      type: "none",
      setType: (type) => set({ type }),
    }),
    { name: "vapp-global-animation" }
  )
);

export default useGlobalAnimationStore;
