# AI-Edit — Drama (v2) pipeline

The default director in the AI-Edit panel. Turns a one-line idea into a finished, ordered
mini-drama on the timeline — handling **both** pure narration (faceless-style) **and** on-camera
dialogue (lip-sync) from the *same* prompt. Which one you get is decided by the content, not a mode.

Fully isolated from `comic_drama` / `faceless_video` / plain Edit — tuning it never touches them.

## Flow

```
USER PROMPT (king)  +  optional REFERENCE IMAGE(s)
        │
        ▼
1. SCRIPT  (drama_script task, model_config.json)  ── vision if a ref is attached (one read)
        → a TAGGED SCREENPLAY, one line per shot, in order:
             NARRATOR: <what the off-screen narrator says>
             DIALOGUE [Name]: <what the character says ON camera>
        → shot count is KING: N shots → ~N lines.
        │
        ▼
2. DIRECTOR  (DRAMA_V2_PROMPT, editor-config.ts)
        → shot-list, ONE shot per line:
             NARRATOR → image / b-roll video / stock
             DIALOGUE → a talk:true video that SPEAKS the line (lip-sync; LTX reads `says '…'`)
        → REFERENCE rule: describe only edit deltas (no faces), short Flux-edit prompts.
        │
        ▼
3. ASSEMBLER  (runBuildDrama, ai-edit-panel.tsx — gated on pipeline==drama_v2)
        • split screenplay → beats; NARRATOR voiceover = narrator lines only (audio op)
        • generate every shot in PARALLEL; batch job-poll (/api/jobs-status)
        • each shot lands + shows a chat preview the moment it's ready
        • VIDEOS pass known dims (aspect-ratio + seconds) → designcombo skips the download → INSTANT
        • ONE category-row arrange at the end: images→row, videos→row, narration→one audio row,
          laid BACK-TO-BACK in beat order (sequential → narrator + dialogue audio never overlap)
```

## Why sequential (no matcher / no transcribe)

The relevance-matcher + transcribe path crammed all shots into one voiceover and truncated the
dialogue videos (their audio overlapped the narration). The assembler instead lays shots end-to-end
in screenplay order: each narrator beat carries its own voice clip, each dialogue video carries its
own voice — so audio never overlaps and placement never needs a transcript.

## Key implementation notes

- **Batch status** — `waitGen` registers ids in a shared poller; ONE short `/api/jobs-status?ids=…`
  every ~2s reads `vapp_jobs` (no per-job long-poll → proxy-safe, efficient for parallel gens).
- **Instant video land** — `@designcombo/state` downloads a clip just to read its dimensions before
  the item appears. Its VIDEO loader (`Ki`) SKIPS that when `duration+width+height` are known, so
  `addVideo(src,name,{width,height,durationMs})` lands videos instantly; pixels stream after. The
  IMAGE loader always downloads (small clips + an add-retry cover the fresh-object CDN warm-up).
- **talk:true** flag (not a hard-coded "says") marks a dialogue shot; a broad speech-verb regex is
  only a fallback.
- **Reference images** — attached in the composer (paste / drop / link / select a timeline image);
  the SCRIPT step (vision) sees them once; image shots route to `vapp-image-edit` (identity-keeping).

## Pending / roadmap

- Phase 3 audio: voice-changer on LTX dialogue audio (LTX voice is rough), music duck, batch-TTS.
- Chat thumbnails/posters (needs the vApp to emit small posters — chat currently shows the full clip).
- Per-shot regen/edit on the timeline (AI = first draft, user finishes manually).
