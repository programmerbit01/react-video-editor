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
| **Stock search** (Pexels) image/video | ✅ |
| **Image edit** (AI img2img regenerate — "make it red") | ✅ |
| **Smart arrange** — importance weighting + build a whole video from one prompt (`target:"all"`) | ✅ |
| **Exact script‑sync** — transcribe voiceover → place each image WHEN it's spoken | ✅ |
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
| `generate` | TTS audio / AI image / AI video | vApp job → poll → `ADD_AUDIO`/`ADD_ITEMS`/`ADD_VIDEO` |
| `regenerate` | AI image edit (img2img) | vApp job → `EDIT_OBJECT details.src` |
| `search` | stock (Pexels) image/video | `/api/pexels` → add |
| `arrange` | sequence to build a video: `itemIds`+`totalMs` (equal), `items:[{itemId,fromMs,toMs}]` (smart), or `target:"all"` (all visual items after generation) | `stateManager.updateState` (display timing) |
| `captions` | word‑synced caption track under the selected audio (transcribes first if there's no transcript yet) | `caption-builder.ts` → `stateManager.updateState` (new Captions track) |

**Zoom is Ken Burns.** The Remotion player ignores a static `details.transform`; it
computes zoom/pan per frame from `details.kenBurns` (`zoomIn`/`zoomOut`/`panLeft`…).

**Two mutation paths**, both auto‑undoable (Ctrl+Z): details/animations →
`dispatch(EDIT_OBJECT)`; timing/structure → `getStateManagerRef().updateState(…, {updateHistory:true})`.

---

## 🔌 Endpoints (editor route → vApp)

| Editor route | vApp endpoint(s) | Purpose |
|---|---|---|
| `POST /api/ai-edit` | `POST /v1/chat/completions` (stream:false, `litellm/*`) | plan ops from a prompt |
| `GET /api/ai-edit` | `GET /v1/models` | model dropdown (litellm/*) |
| `POST /api/ai-generate` | `POST /api/v1/{model}` (`vapp-fastest-tts`/`vapp-image`/`vapp-video`) | start a media job → `request_id` |
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

## 📁 Key files

**Editor** (`src/features/editor/`)
- `ai-edit/operations.ts` — ops schema, `applyOperations`, `add*`/`replaceMedia`/`setSelection`,
  `captureSnapshot`/`revertSnapshot`, `projectContext`/`narrationTimeline`, `CAPABILITIES`, `OPS_SYSTEM_PROMPT`.
- `ai-edit/caption-builder.ts` — builds a word‑synced **Captions** track from a transcript (same logic as the Captions tab); powers the `captions` op.
- `store/use-ai-edit-store.ts` — panel + chat + history + settings state (persisted prefs/pos).
- `control-item/ai-edit-panel.tsx` — the panel: streaming chat, chips, inline apply/revert,
  Features popover, background generation, transcribe + script‑sync.
- `control-item/captions-panel.tsx` — built‑in Captions (word/segment highlight).
- `store/use-caption-transcribe-store.ts` — per‑audio transcript cache (persisted → survives refresh).

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
