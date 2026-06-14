import { create } from "zustand";

export interface CaptionStyle {
  fontSize: number;
  color: string;
  activeColor: string;
  activeFillColor: string;
  backgroundColor: string;
  position: "top" | "center" | "bottom";
}

interface CaptionStyleStore extends CaptionStyle {
  setStyle: (updates: Partial<CaptionStyle>) => void;
}

const useCaptionStyleStore = create<CaptionStyleStore>((set) => ({
  fontSize: 22,
  color: "#FFFFFF",
  activeColor: "#F5E7BE",
  activeFillColor: "#7E12FF",
  backgroundColor: "rgba(0,0,0,0)",
  position: "bottom",
  setStyle: (updates) => set((s) => ({ ...s, ...updates }))
}));

export default useCaptionStyleStore;
