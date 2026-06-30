import { IAudio } from "@designcombo/types";

export const SFX_LIBRARY = [
  {
    id: "sfx_whoosh_soft",
    details: {
      src: "/sfx/whoosh-soft.wav"
    },
    name: "Whoosh Soft",
    type: "audio",
    metadata: {
      author: "Bundled local",
      durationMs: 720
    }
  },
  {
    id: "sfx_swoosh_fast",
    details: {
      src: "/sfx/swoosh-fast.wav"
    },
    name: "Swoosh Fast",
    type: "audio",
    metadata: {
      author: "Bundled local",
      durationMs: 580
    }
  },
  {
    id: "sfx_impact_hit",
    details: {
      src: "/sfx/impact-hit.wav"
    },
    name: "Impact Hit",
    type: "audio",
    metadata: {
      author: "Bundled local",
      durationMs: 380
    }
  },
  {
    id: "sfx_riser_glow",
    details: {
      src: "/sfx/riser-glow.wav"
    },
    name: "Riser Glow",
    type: "audio",
    metadata: {
      author: "Bundled local",
      durationMs: 1250
    }
  }
] as Partial<IAudio>[];
