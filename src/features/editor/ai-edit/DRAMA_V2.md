# AI-Edit — pipelines & Drama (v2)

The AI-Edit composer dropdown has **two generation categories**, split by the ONLY thing that
changes the *engine* — whether characters speak on camera:

| Dropdown | id | Engine | Use |
|---|---|---|---|
| 🎙️ **Non-lip-sync video** *(default)* | `faceless_video` | full-audio transcription + image-prompt relevance **MATCHER** (`runBuild` + `match_shots`) | narration over images / b-roll, no talking heads — the common case |
| 🎬 **Lip-sync video (Drama v2)** | `drama_v2` | per-shot screenplay **ASSEMBLER** (`runBuildDrama`) | characters speak on camera (+ narration) |

The dropdown opens with a **"Video type · how it builds"** heading; **hovering** an item reveals a one-line
description of what that engine does. `faceless_video` is the **default** director (store `pipeline` default).

> **Video prompts = natural sentences.** Every generated-VIDEO prompt (both pipelines: talk shots and
> b-roll) is written as **plain full sentences**, never a comma-separated keyword/tag list — tag-piles
> break LTX (garbled lip-sync, weak motion). The directors are instructed accordingly. Image prompts
> (Flux) are unaffected.

They are genuinely **different engines** — never merged. **Style** (drama / comic / noir / documentary…)
is a **prompt** concern, not a category. (Plain "Edit" mode and the old `comic_drama` prompt still exist
in code but are no longer listed in the dropdown.)

---

## Drama v2 flow

```
USER PROMPT (king)  +  optional REFERENCE IMAGE(s)
        │
        ▼
1. SCRIPT  (drama_script task, model_config.json)  ── vision if a ref is attached (one read)
        → a TAGGED SCREENPLAY, one line per shot, in order:
             NARRATOR: <what the off-screen narrator says>
             DIALOGUE [Name]: <what the character says ON camera>
        → LINE COUNT = SHOT COUNT (N shots → exactly N lines); "5 sentences per lip-sync video"
          = 5 sentences on ONE DIALOGUE line, NOT 5 lines. Exact tags only (NARRATOR / DIALOGUE).
          Spoken words only (never scene/camera directions). Perspective + dialogue-vs-narration follow
          the request. NO word/duration budget of its own.
        │
        ▼
2. DIRECTOR  (DRAMA_V2_PROMPT, editor-config.ts)
        → shot-list, ONE shot per line:
             NARRATOR → image / b-roll video / stock
             DIALOGUE → a talk:true video; the spoken WORDS go in `line` (NOT the prompt);
                        the prompt is a NATURAL SENTENCE ending "…looks at the camera and speaks"
                        (comma tag-piles break LTX lip-sync).
        → SUMMARY announces any default it had to assume (perspective, length, style…) — transparency,
          shown as the reply so a guess never looks like a glitch.
        │
        ▼
3. ASSEMBLER  (runBuildDrama, ai-edit-panel.tsx — gated on pipeline==drama_v2)
        • SHOT-DRIVEN + tolerant: builds the director's ordered shot-list; NEVER falls back to the
          matcher on a screenplay/shot count drift (parser tolerates tag typos: DIALOG*/NARRATION/VO)
        • talk shots carry their OWN voice; each b-roll shot pulls the next narrator line (best-effort)
        • generate every shot in PARALLEL; batch job-poll (/api/jobs-status); each shot lands + shows a
          captioned chat preview the moment it's ready
        • ONE category-row arrange at the end: images→row, videos→row, narration→one audio row,
          laid BACK-TO-BACK in order (sequential → audio never overlaps)
```

---

## Lip-sync (the hard part) — two paths

LTX (vapp-video) lip-sync is unreliable when the prompt is a tag-pile or overloaded; it works with a
**natural sentence + the face toward camera**. Two paths, chosen automatically:

- **Reference image attached → i2v + AUDIO** (`LIPSYNC_WITH_AUDIO` path, always used when a ref is
  present). Clean TTS is generated, the ref is Flux-edited into the shot look (`LIPSYNC_I2V_EDIT_FIRST`
  — LTX animates its input image as-is, so the outfit/scene must be baked in), the video is generated
  with `audio`=TTS and `duration:0` → the vApp sizes the video to the real audio +1s tail
  (`backend_wan2gp.py:_cap_video_duration_to_audio`). Video muted + TTS overlaid.
- **No reference → T2V** (default; `LIPSYNC_WITH_AUDIO=false`). LTX generates its OWN speech from the
  words — best lips + full camera freedom. The director keeps the words in `line`; the client appends
  them in **double quotes** for t2v (so the director's JSON stays valid). Uses LTX's own audio.

### Duration = speech PACE (T2V)
LTX **fits the words into whatever duration it's given** — short clip = fast, long = extreme-slow. So
the duration is the pace knob. Size it for a natural rate:

```
seconds = clamp( round(words * 60 / LIPSYNC_WPM), LIPSYNC_MIN_SECS, LIPSYNC_MAX_SECS )
```

`LIPSYNC_WPM = 140` (natural; the old `words/2.5 * 2.0` was ~75 WPM = the "extreme slow" talking).
Audio-driven (ref) path ignores this — the vApp sizes the video to the TTS audio instead. Exact
single-pass "generative camera move + perfect timing" is NOT deterministic — accepted trade-off.

---

## Stock (both pipelines)

- **Source** (`search` op `source` field): default **`pexels`** (modern b-roll, orientation-filtered);
  **`archive`** = Internet Archive (historical / vintage / higher quality), `openverse` / `wikimedia`
  = free/CC — routed through the shared `/api/archival` (same route the Stock panel uses, so playback/
  CORS already work). The director sets `source` from the user's request; no source → Pexels.
- **Aspect** — Pexels is orientation-filtered (`aspectOrientation`, falling back to `_pipeAspect` when
  the director forgets to tag the op). Archival has no orientation filter.
- **Cover-fit** — stock is never exactly 16:9/9:16, so on add the item box is sized to the whole canvas
  (`coverFitToCanvas`); the player renders media `object-fit:cover` → it FILLS the frame (crops the
  overflow), no letterbox, no manual fitting.

---

## Chat previews & UX

- Each preview is **captioned** with its source + prompt: `(gen) …`, `(stock:pexels) …`,
  `(stock:archive) …`, `(voice) …` — prompt/line above, media below.
- The chat **auto-scrolls only while pinned to the bottom** (`stickBottomRef` + onScroll); scroll up
  mid-generation and it leaves you alone, scroll back down and follow resumes.

---

## Config knobs (`editor-config.ts`)

| Knob | Default | Meaning |
|---|---|---|
| `LIPSYNC_WITH_AUDIO` | `false` | non-ref talk shots: false = T2V (own speech), true = feed TTS as audio. Ref shots always use audio. |
| `LIPSYNC_I2V_EDIT_FIRST` | `true` | i2v: Flux-edit the ref into the shot look before animating (LTX won't restyle from the prompt). |
| `LIPSYNC_WPM` | `140` | T2V speaking rate (words/min): higher = faster, lower = slower. |
| `LIPSYNC_MIN_SECS` / `LIPSYNC_MAX_SECS` | `2` / `25` | T2V clip length clamp (~5 sentences at a natural pace). |
| `LIPSYNC_VIDEO_MAX_SECS` | `120` | timeline dims/instant-land hint for audio-driven talk clips (NOT a generation cap). |

---

## Key implementation notes

- **Batch status** — `waitGen` registers ids in a shared poller; ONE short `/api/jobs-status?ids=…`
  every ~2s reads `vapp_jobs` (proxy-safe, efficient for parallel gens).
- **Instant video land** — `@designcombo/state` downloads a clip just to read its dims; its VIDEO loader
  SKIPS that when `duration+width+height` are known, so `addVideo(src,name,{width,height,durationMs})`
  lands videos instantly. Talk videos add-retry (fresh-R2 CDN warm-up); audio adds retry too.
- **talk:true** flag (not a hard-coded "says") marks a dialogue shot.
- **Reference images** — attached in the composer (paste / drop / link / select a timeline image); the
  SCRIPT step (vision) sees them once; image shots route to `vapp-image-edit` (identity-keeping).

---

## Pending / roadmap

- Faceless overlap: `[ARRANGE IN]` / `[ARRANGE READBACK]` diagnostic logs added to pinpoint a
  video-under-image overlap before fixing it.
- Phase 3 audio: voice-changer on LTX dialogue audio, music duck, batch-TTS, per-character voice_id.
- Chat thumbnails/posters (chat currently shows the full clip; video posters via `/api/media-poster`).
- Per-shot regen/edit on the timeline (AI = first draft, user finishes manually).
