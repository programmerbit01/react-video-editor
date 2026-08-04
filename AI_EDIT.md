# AI Edit — Prompt‑to‑Edit & Generate

> An in‑editor AI panel that turns natural‑language prompts into **timeline edits** and
> **generated media** — an "AI video director" living inside react‑video‑editor.
> Type what you want ("make this 3s", "zoom in", "add a voiceover about Pakistan",
> "find 3 stock clips", "sync the images to the narration") → it plans **operations**,
> previews them, and applies them to the timeline.

---

## 🎯 Ultimate goal

A **local AI content factory**: a single prompt → a **finished, script‑synced video**
(voiceover + generated/stock media + motion + captions) — like a human editor did it.
Everything runs on self‑hosted vApp (no cloud, no paid APIs).

Two products on the same rails:
1. **Now** — faceless YouTube / VidRush‑style videos (topic/script → media → voiceover → assembled video).
2. **Later** — viral vertical mini‑dramas (character consistency, dialogue) — same glue reused.

The AI Edit panel is the **interactive front‑end to the same ops + timeline** that an
automated MCP pipeline will later drive end‑to‑end.

---

## ✅ Where we've reached

| Capability | Status |
|---|---|
| Prompt → edit: duration, **Ken Burns zoom/pan**, opacity, volume, speed, delete, fade, text, font/color | ✅ |
| **Generate** audio (TTS), image, video — background + non‑blocking, live progress | ✅ |
| **Prompt optimization** — image/video generate prompts auto‑rewritten model‑friendly via `/vapp/llm` (`optimize_image`/`optimize_video`) before generating; ✨ shown, fail‑open, `AI_GENERATE_OPTIMIZE=0` to disable | ✅ |
| **Stock search** (Pexels) image/video | ✅ |
| **Image edit** (AI img2img regenerate — "make it red") | ✅ |
| **Smart arrange** — the EXECUTOR owns timing (never the LLM); build a whole video from one prompt (`target:"all"`) | ✅ |
| **Content-aware RELEVANCY** — each shot matched to the narration MOMENT it depicts + reordered by relevance (LLM `match_shots`, using each image's prompt from `metadata.prompt`/vApp `media.meta`) | ✅ |
| **Exact script‑sync** — transcribe voiceover → place each image WHEN it's spoken | ✅ |
| **Category rows** — arrange groups images→one row, videos→another (above audio); captions stay glued under the audio (arrange only touches image/video) | ✅ |
| **Audio is king** — video length = the voiceover length; arrange waits for the audio to land + spans its real `meta.duration`; pipelines write the script to the requested seconds (~2.5 words/s) | ✅ |
| **Context‑awareness** — knows the narration topic (generates relevant media, not literal words) | ✅ |
| History + **inline revert**, **Auto/Ask** mode, streaming + thinking toggles, gen previews | ✅ |
| Transcribe pipeline (word/segment highlight) + **persists across refresh** | ✅ |
| **Auto‑captions** — word‑synced caption track from a prompt (transcribes the audio first if needed) | ✅ |
| Panel **opens by default** on load; selection chips → click selects just that clip **+ moves the playhead**, × deselects | ✅ |
| **Transitions** (crossfades), cross‑device transcript persistence, MCP auto‑pipeline | 🔜 |

---

## 🏗️ Architecture

**Ownership split (durable):**
- **Editor owns** — the AI Edit panel, the operations schema, applying ops to the
  timeline (via `@designcombo/state` dispatch), and its own `/api/*` routes.
- **vApp owns** — the LLM (LiteLLM/Dify), media generation, transcription. The editor
  calls these **directly**.

**No vapp_higgs, no proxy — one env knob.**
Every editor→vApp call goes:
```
browser → editor's own /editor/api/* route → VAPP_SERVER_BASE (the vApp) directly
```
- `VAPP_SERVER_BASE` (env, default `http://127.0.0.1:8091`) is the single place that
  points at the vApp. No client‑supplied base URLs, no vapp_higgs hop.
- `withEditorBase()` prefixes `/editor` (the editor runs under Next `basePath:'/editor'`),
  so the browser hits the editor's routes, not the parent app.

**The panel shell** is cloned from the Script drawer (drag / resize / minimize / snap to
`#editor-right-panel`), toggled by the navbar **✦ AI Edit** button.

---

## 🧩 Operations schema (durable envelope)

The LLM returns **only** a fenced JSON block. The envelope never changes — only new
`op` types get added:

```json
{ "summary": "one line", "operations": [ ...ops... ] }
```

| op | What | Applied via |
|---|---|---|
| `edit` | `details` patch (kenBurns, opacity, volume, text, fontSize…) or `durationMs` or `playbackRate` | `EDIT_OBJECT` / `stateManager.updateState` (timing) |
| `fade` | fade in/out | `EDIT_OBJECT` (`animations`) |
| `delete` | remove items | `LAYER_DELETE` |
| `add` | text overlay | `ADD_TEXT` |
| `generate` | TTS audio (`voice_id` optional) / AI image / AI video | vApp job → poll → `ADD_AUDIO`/`ADD_ITEMS`/`ADD_VIDEO` |
| `regenerate` | AI image edit (img2img) | vApp job → `EDIT_OBJECT details.src` |
| `music` | **generate ORIGINAL music** (ACE‑Step `vapp-music-gen-1`, the same model Voice Studio "Generate music" uses); director writes a SHORT mood, the `optimize_music` LLM task crafts the full ACE prompt (instrumental, no vocals) | vApp job → poll → laid in as a background **music bed** (`musicbed` placement) |
| `stocksfx` | **add real stock SOUND EFFECTS from the TRANSCRIPT** — the request transcribes the audio first, then the director emits ONE op carrying timed `cues:[{query, atMs}]`; each cue's SHORT keywords are searched (default source **Openverse**; `source` = `wikimedia`/`archive` only if the user names it), the **shortest** clip is picked and **capped to ≤5 s**, and ALL cues land on **ONE shared "SFX" row** at their transcript moments | per-cue `/api/archival?type=sound&sound_kind=sfx` → `ADD_AUDIO` → `placeAudioClips(trackRole:"sfx")`. **Preferred SFX path** — no generation, no artifacts |
| `stockmusic` | **add a real stock MUSIC bed** (default source Openverse); director derives the mood/genre query | `/api/archival?type=sound&sound_kind=music` → `musicbed` placement (one full‑length bed, ≈20% vol) |
| `sfx` | **AI‑generate foley for a VIDEO** — MMAudio *remux* (`vapp-sfx` → wan2gp `edit_remux`, watches the frames, NO video regeneration); returns an audio‑only `.wav` (worker extracts it) laid UNDER the clip so the original voice is kept. A default negative prompt suppresses MMAudio's speech/music hallucinations | vApp job → poll → `ADD_AUDIO` under the clip |
| `musicbed` | background bed from the **curated** audio library (Stock→Sound), not AI | client picks src → `upsertMusicBed` |
| `search` | stock (Pexels / Internet Archive…) image/video | `/api/pexels` · `/api/archival` → add |
| `arrange` | sequence to build a video: `itemIds`+`totalMs` (equal), `items:[{itemId,fromMs,toMs}]` (smart), or `target:"all"` (all visual items after generation) | `stateManager.updateState` (display timing) |
| `captions` | word‑synced caption track under the selected audio (transcribes first if there's no transcript yet) | `captions/builder.ts` → `stateManager.updateState` (new Captions track) |

**Zoom is Ken Burns.** The Remotion player ignores a static `details.transform`; it
computes zoom/pan per frame from `details.kenBurns` (`zoomIn`/`zoomOut`/`panLeft`…).

**Two mutation paths**, both auto‑undoable (Ctrl+Z): details/animations →
`dispatch(EDIT_OBJECT)`; timing/structure → `getStateManagerRef().updateState(…, {updateHistory:true})`.

---

## 🧭 Edit mode = a lean INTENT ROUTER (single ops, no pipeline mixing)

Plain **Edit / General** (`pipeline === ""`) is deliberately **independent** of the Faceless/Drama
pipelines. Small local models fumble a bloated all‑ops prompt, so a send in Edit mode:

1. tries the lean **`edit_intent`** router first — one focused, JSON‑only call that maps the instruction
   straight to the `{summary,operations}` envelope (the plan box shows **"⚙ Plan"**, not "🎬 Directing");
2. falls back to the full `OPS_SYSTEM_PROMPT` director only if the router yields no ops.

Rules that keep it clean:
- **SINGLE tasks only** — one edit, one generate/search, one sfx/music, one arrange. The whole‑video
  auto‑director (`direct`) was **removed** from Edit mode — building a full video from a topic is a
  *pipeline* the user picks from the director dropdown, never an Edit‑mode op.
- **Length is reused, not hardcoded** — "30‑second audio about X" → the router emits
  `{kind:"audio",text:"__SCRIPT__",topic,durationSec}` and the client writes the narration via the
  existing length‑aware **`script`** task (30s ≈ 75 words). No client word‑count, no cropping.
- **Aspect is honored** — the router copies the orientation the user names onto every generate op
  (`9:16`/`16:9`/`1:1`); the vApp already maps it to a real resolution (LTX `720x1280` etc.).
- **`animate` (i2v)** honors aspect + duration, **waits for the video to land** (`serializedAdd`) before
  replacing the still, and — when **✨ optimise** is on — sends the SOURCE image to the vision optimiser
  (`/api/optimize-prompt` → `/vapp/prompt/optimize`) so the motion prompt is written from what's in the image.

Chat results are **draggable onto the timeline** (same `Draggable` payload the Stock/vApp media tiles use).
The **✨ optimise** toggle is surfaced in the run row (auto / stream / fast / ✨ optimise).

---

## 🔌 Endpoints (editor route → vApp)

| Editor route | vApp endpoint(s) | Purpose |
|---|---|---|
| `POST /api/ai-edit` | `POST /v1/chat/completions` (stream:false, `litellm/*`) | plan ops from a prompt |
| `GET /api/ai-edit` | `GET /v1/models` | model dropdown (litellm/*) |
| `POST /api/ai-generate` | `POST /api/v1/{model}` (`eleven-multilingual-v2`/`vapp-image`/`vapp-video`/`vapp-music-gen-1`/`vapp-sfx`) | start a media job → `request_id` (`vapp-sfx` = MMAudio remux: send `video_url` + optional prompt) |
| `POST /api/optimize-prompt` | `POST /vapp/prompt/optimize` (the SAME endpoint Image/Video Studio use) | **VISION** prompt optimiser — pass `media` (a source-image url) and the optimiser model SEES it and writes the prompt from what's in the picture (i2v animate). Fail‑open |
| `POST /api/ai-llm` (task `edit_intent`) | `POST /vapp/llm` | **Edit‑mode intent router** — a lean JSON classifier that maps ONE Edit instruction → the `{summary,operations}` envelope; single ops only |
| `GET /api/ai-generate?id=` | `GET /vapp/wait_job/{id}?timeout=` | long‑poll (done + `output_url`, or `queue_position`/`progress`) |
| `POST /api/transcribe` | `POST /vapp/transcribe` | start STT job |
| `GET /api/transcribe/[id]` | `GET /api/v1/predictions/{id}/result` | poll → clean `{status,done,failed,stt}` |

**Transcribe / STT shape** (canonical): PB `vapp_jobs.result.stt` =
`{language, segment_count, segments:[{start,end,text,words:[{start,end,word,probability}]}]}`
(seconds). vApp exposes it as `raw.stt`; the editor route returns a clean `{stt}` and both
consumers read `stt.segments` directly (no legacy `generation_details`).

**Generation is background.** Apply returns immediately; each job long‑polls `wait_job`
in the background (shows "Queued #N…/Generating X%…"), then adds to the timeline. The
chat stays free — the user can keep prompting. An `arrange` op in the same message runs
**after** all generations finish (so the just‑created items exist).

---

## 🩺 Reliability & diagnostics (non‑lip‑sync)

**Symptom:** the voiceover sometimes never reaches the timeline (worse on slow internet;
same prompt succeeds one run, fails the next).

**Root cause — the audio op is coupled to the director's shot‑plan JSON:**
- The narration `script` is written FIRST (its own LLM stream) → `injectedScript`.
- The **audio op is only created inside** `if (env && env.operations?.length)` — i.e. ONLY
  when the director's shot‑plan JSON parsed into ≥1 op. If that JSON is empty / cut‑off /
  invalid (or its SSE stream drops), `injectedScript` is discarded → **audio gen never runs**.
- The director JSON goes "incomplete" two ways: **server‑cut** (`max_tokens`) or **net‑drop**
  (the SSE stream stalls — worse on slow internet). LLM non‑determinism = same prompt can
  parse one run and break the next.

**Shipped:**
- **max_tokens** — `editor_edit` had none → defaulted to **1200** (`vapp_llm/llm_service.py`
  `setdefault("max_tokens", 1200)`), truncating a 15‑shot JSON. Set to **16000** in
  `configs/model_config.json` (matches `script`/`drama_script`). Config = live‑reload.
- **Red console diagnostics** — on any director/script failure `console.error` now classifies
  the cause with char‑count + elapsed ms + reply tail (`diagnoseDirectorReply`):
  `TRUNCATED / cut mid‑JSON (max_tokens OR SSE drop)` · `MALFORMED JSON` ·
  `EMPTY (stream dropped)` · `stream ERROR (network/timeout)` · `0 operations`.

**Pending (real robustness):** *decouple* the voiceover from the director ops — when
`injectedScript` exists but the shot‑plan yields no ops, still generate/place the audio from
the script, guarded by `s.pipeline && injectedScript` (Edit mode + the success path untouched).
Then a bad/dropped director JSON never loses the narration.

> Secondary (separate bugs): designcombo's `ADD_AUDIO` reducer always does a client‑side
> `new Audio()` metadata load (ignores a supplied `duration`, unlike `ADD_VIDEO`) → a slow /
> CORS‑flaky CDN can still drop the clip at the *add* step (~10%). And a
> `calcBounding: reading 'left' of undefined` crash can abort a state commit on a racey,
> half‑built timeline.

---

## 📁 Key files

**Editor** (`src/features/editor/`)
- `ai-edit/operations.ts` — ops schema, `applyOperations`, `add*`/`replaceMedia`/`setSelection`,
  `captureSnapshot`/`revertSnapshot`, `projectContext`/`narrationTimeline`, `CAPABILITIES`, `OPS_SYSTEM_PROMPT`.
- `captions/builder.ts` — builds a word‑synced **Captions** track from a transcript; powers the `captions` op. A known duplicate of `captions/generate.ts`, which is the standard — see [CAPTIONS.md](CAPTIONS.md) before touching either.
- `store/use-ai-edit-store.ts` — panel + chat + history + settings state (persisted prefs/pos).
- `control-item/ai-edit-panel.tsx` — the panel: streaming chat, chips, inline apply/revert,
  Features popover, background generation, transcribe + script‑sync.
- `captions/panel.tsx` — the one and only Captions UI (left menu). See [CAPTIONS.md](CAPTIONS.md).
- `captions/transcribe-store.ts` — per‑audio transcript cache (persisted → survives refresh).

**Editor API** (`src/app/api/`) — `ai-edit/route.ts`, `ai-generate/route.ts`,
`transcribe/route.ts`, `transcribe/[id]/route.ts`.

**vApp** (`vapp_server/vapp_server.py`) — `/v1/chat/completions`, `/v1/models`,
`/api/v1/{model}`, `/vapp/wait_job/{id}`, `/vapp/transcribe`,
`/api/v1/predictions/{id}/result` (`_pb_stt` exposes `result.stt`), and a `vapp_editor`
logging middleware → `logs/vapp_editor.log`.

---

## 🎬 The flow (prompt → finished video)

```
1. "add a voiceover about Pakistan"      → TTS audio (topic is now known)
2. "find 4 stock images for this"        → context‑aware, relevant clips
3. "sync the images to the narration"    → transcribe → each image at its spoken moment
4. "add varied zoom to each"             → dynamic Ken Burns
→ a human‑like, script‑synced video, all from prompts
```

The panel is the manual driver of the same operations an MCP pipeline will later automate.
