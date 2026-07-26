# AI Edit — Core Ops + Pipelines (motion-drama / faceless)

## Goal
Professional, AI-driven video editing inside the timeline. Everything the AI does lands on the
**editable timeline** (not a black-box MP4), so the user stays the director. Built as:

```
CORE OPS (operations.ts)  =  system prompt (what the LLM may emit) + executor (how each op is applied)
       ↑ COMPOSE (params/config) — never fork the core
LAYERS  =  pipelines (Comic Drama / Faceless Video)  =  a DIFFERENT system prompt over the SAME ops
```

**Dev rule:** build/test a new core op in plain **Edit** mode first (simple, direct), THEN the
pipelines just reuse it. Core first. No hardcoded steps — the LLM plans, the executor executes,
mechanics (timing, motion, transitions…) live in code.

## The BEAT MODEL (the one shared context)
A pipeline/arrange build produces `msg.beats` — for each shot: `{ itemId, fromMs, toMs, text }`
(its timeline slot + the narration spoken during it). This ONE context object drives the arrange
now, and **animate / effects / lip-sync** read it later so their motion/prompts are context-aware.

## What's built
- **Pipeline dropdown** (by Send): `✦ Edit` · `🎭 Comic Drama` · `🎬 Faceless Video`. Selecting a
  pipeline swaps the system prompt; the LLM emits `generate`/`arrange` ops that build on the live
  timeline. (`operations.ts` prompts, `store` `pipeline` state, `ai-edit-panel.tsx` dropdown.)
- **Smart `arrange` core op** (works in Edit mode too): targets the just-generated shots OR, when
  the user says "arrange" over existing clips, the SELECTED / ALL visuals. **The executor OWNS the
  timing — never the LLM** (timing is a mechanic, not a decision). The LLM only emits
  `{op:"arrange","target":"all"}` (no times). Flow:
  1. **Transcript** — reuse the Captions-tab transcript if present (instant), else the LIVE
     `/api/transcribe`. Capped so it can't hang.
  2. **RELEVANCY (the win)** — each shot's DESCRIPTION (`metadata.prompt` for generated images —
     ADD_ITEMS strips `name`→"image" but preserves `metadata`; else vApp `media.meta` via
     `/api/media-meta`) + the timed narration → LLM task **`match_shots`** places each image at the
     narration MOMENT it depicts (fortune image first, weapon mid, burn last) and **reorders by
     relevance**. `normalizeShotWindows` forces contiguous/gap-free coverage. All live — no restart.
  3. **transcript even-snap** (selection order) if descriptions are missing; **even split** if no
     voiceover.
  Then it **consolidates into CATEGORY ROWS** — images on ONE row, videos on another (per-type
  tracks, above audio; vacated rows pruned) — contiguous & gap-free (timeline total = voiceover,
  no black tail), applies alternating **Ken Burns**, and reports. **Captions/text are NEVER touched**
  (arrange = image/video only), so they stay glued under the audio. Builds the beat model (each
  shot's slot + its narration) so animate / effects / lip-sync stay context-aware.
- **`animate` op** — turn a selected image into a VIDEO (image-to-video / LTX i2v), keeping it in
  the SAME timeline slot. The "cheap images first → upgrade selected shots to video" flow.
- **i2v support** in `/api/ai-generate` (video accepts `image_url`).
- **max_tokens 1200 → 8000** in `/api/ai-edit` (a 12-shot pipeline JSON was truncating → the plan
  came back as invalid JSON and silently did nothing; now shows a clear error if it ever is cut off).
- **Detailed console logs** `[AI-Edit arrange] …` at every step (cache hit, transcribe call/return/
  timeout, segments, beats, apply, errors) — so failures are diagnosable, not silent.

## Files
- `src/features/editor/ai-edit/operations.ts` — ops vocabulary + `applyOperations` executor +
  `OPS_SYSTEM_PROMPT` + `COMIC_DRAMA_PROMPT` / `FACELESS_EDIT_PROMPT` + `animate`/`arrange` docs.
- `src/features/editor/control-item/ai-edit-panel.tsx` — orchestration (`runPrompt` / `runGen` /
  `runBuild` beat-model arrange / `applyMsg`) + the pipeline dropdown + logs.
- `src/features/editor/store/use-ai-edit-store.ts` — `pipeline` state + `beats` (the context) on each message.
- `src/app/api/ai-generate/route.ts` — i2v; audio model `eleven-multilingual-v2`.
- `src/app/api/ai-edit/route.ts` — max_tokens.
- `src/app/api/beat-plan/route.ts` — thin proxy → vApp `/vapp/beat_plan` (context-aware shot timing;
  reuses VidRush's transcribe → beat_plan; server-side so the editor never transcribes on the client).
- `src/app/api/media-meta/route.ts` — vApp `media.meta` (prompt for relevancy + real duration for audio-is-king).
- `src/app/api/editor-log/route.ts` — ships the `[AI-Edit …]` trace to `logs/vapp_editor.log` (server-readable).

## Roadmap (each = a core op, tested in Edit, then reused by pipelines)
- **Category-wise tracks** — visuals sequential (image/video rows, non-overlapping) + audio parallel
  rows (voiceover / music bed / SFX / captions). Clean, no clutter.
- **`transition`** (fade/slide), **`music`** bed (acestep) + user-addable, **`sfx`** + user-addable,
  **`lipsync`** (video↔audio).
- **Content-match arrange** — for ARBITRARY images (not made for the narration), an LLM/embedding
  match so placement is by MEANING, not just even time. (Pipeline shots are already order-relevant.)

## Status — WORKING end-to-end (production-verified)
A full Comic Drama build (10 shots = 8 images + 2 videos, 40s voiceover) generates, lands, and
arranges into one synced 51s timeline — audio on its own row, images grouped, content-matched,
motion applied. The pieces that got it foolproof:
- **Executor owns timing** — the arrange ALWAYS computes content-aware windows (LLM never passes
  times). Relevancy via `match_shots` (each shot → the narration moment it depicts). Audio-is-king:
  video length = the voiceover.
- **`addAudio` minimal payload** — passing `display` made designcombo's `ADD_AUDIO` silently drop the
  clip ("no voiceover on the timeline"); the reducer computes the real duration itself.
- **serializedAdd() mutex** — THE fix for "clips landed then vanished / 2/4 visuals". Concurrent
  `ADD_ITEMS`/`ADD_AUDIO` (async; ADD_AUDIO loads the audio ~13s first) did read-modify-write on
  `trackItemsMap` and clobbered each other. Now each add runs — and is awaited to land — before the
  next. Generation stays parallel; only the mutation is serialized.
- **Auth** — gen + transcribe routes send the token as BOTH `Bearer` (session) and `x-api-key`
  (vk-… API keys); vApp `/api/v1` accepts a vk- key only via x-api-key.
- **Server-readable trace** — `elog()` tees every `[AI-Edit …]` line (incl. per-add item counts) to
  `logs/vapp_editor.log` via `/api/editor-log` → `/vapp/editor_log`.

Restart needed after pulling: `:8091` (new `/vapp/editor_log`, `/vapp/media/meta`, `/vapp/beat_plan`)
+ editor rebuild. Test only on a PRODUCTION build — `next dev` (Turbopack HMR) duplicates the store
module and gives false `waitForItem` timeouts.

## Roadmap / open (discussed, not yet built)
- **Effects as core ops** — `transition` (fade/slide), smarter `kenBurns`, fast-cuts: the LLM emits
  effect ops (context-aware) that call the SAME editable edit ops; executor applies a default so it's
  never bare; user can change any of it. (Today the arrange applies alternating Ken Burns only.)
- **Interleave video shots** — the LLM currently tends to place video shots LAST; prompt it to put
  them at dramatic beats among the images.
- **"apply to ALL items" gap** — an edit like "add Ken Burns to every clip" sometimes skips middle
  items (LLM emits ops for only the last few) — make the executor apply to all when target = all.
- **User-controlled style + effects** — the prompt already takes shots/duration; extend it so the
  user can dictate script STYLE and effect intensity the same way.
- **music bed (acestep) + sfx** rows, **lipsync** (video↔audio).

Build: `npm run build`; the user restarts the editor. Requires the vApp backend (`/api/ai-*` →
vApp `/vapp/llm` + `/api/v1/*`).
