<p align="center">
  <a href="https://github.com/designcombo/react-video-editor">
    <img width="150px" height="150px" src="https://cdn.designcombo.dev/combo-logo-black.png"/>
  </a>
</p>
<h1 align="center">React Video Editor</h1>

<div align="center">
  
Video Editor application using React and TypeScript.

<p align="center">
    <a href="https://designcombo.dev/">Combo</a>
    ·  
    <a href="https://discord.gg/jrZs3wZyM5">Discord</a>
    ·  
    <a href="https://github.com/designcombo/react-video-editor">X</a>
</p>
</div>

[![](./images/combo.png)](https://github.com/designcombo/react-video-editor)

## ✨ Features

- 🎬 Timeline Editing: Arrange and trim media on a visual timeline.
- 🌟 Effects and Transitions: Apply visual effects, filters, and transitions.
- 🔀 Multi-track Support: Edit multiple video and audio tracks simultaneously.
- 📤 Export Options: Save videos in various resolutions and formats.
- 👀 Real-time Preview: See immediate previews of edits.

## 🚀 See It in Action

Check out the deployed version here: [React Video Editor Live Demo](https://video.designcombo.dev/)

## ⌨️ Development

### Environment Variables

Create a `.env` file in the project root and add the following:

```env
PEXELS_API_KEY=""
```

Clone locally:

```bash
git clone git@github.com:designcombo/react-video-editor.git
cd react-video-editor
pnpm install
pnpm dev
```

Open your browser and visit http://localhost:3000 , see more at [Development](https://github.com/designcombo/react-video-editor).

---

## 🗂️ Vapp Media Integration

The editor integrates with a **vapp_server** (FastAPI) + **vapp_higgs** (Next.js proxy) backend stack that stores all user media on Cloudflare R2. This section documents the full lifecycle so future changes are made confidently.

### URL parameters

The editor is embedded in an iframe or opened directly with these query params:

| Param | Purpose |
|-------|---------|
| `token` | PocketBase JWT — identifies the user, required for all API calls |
| `baseUrl` | vapp_server base URL (e.g. `https://api.muapi.ai`) |
| `vappHost` | vapp_higgs origin (e.g. `https://vh2.tomtap.ai`). If omitted, falls back to `window.location.origin` |

---

### Dual-URL pattern (critical)

Every vapp media item carries **two URLs**:

| Field | Path | Purpose |
|-------|------|---------|
| `url` / `metadata.uploadedUrl` | `/api/proxy?url=<encoded-cdn>` | **Remotion player** (`details.src`). Remotion and `loadAudioData` call `fetch()` internally which is CORS-strict. The proxy adds the needed CORS headers. |
| `metadata.directUrl` | `https://rpublic.tomtap.ai/...` | **HTML `<img>` / `<video>` display** and canvas `drawImage()`. Loads directly from CDN — no proxy hop, faster, no server bandwidth. |

Thumbnail images in the uploads panel, the timeline filmstrip, and drag previews all use `metadata.directUrl`. Only Remotion's internal player uses the proxy URL.

---

### Upload panel — fetching media

**File:** `src/features/editor/menu-item/uploads.tsx`

1. On first mount the `useEffect` checks `uploadsLoaded` (Zustand flag). If already `true` and vapp items exist in the store, fetch is skipped.
2. Otherwise it calls `fetchPage(1)` → GET `{vappHost}/api/vapp/media?page=1&per_page=20&token=...&baseUrl=...`
3. vapp_higgs (`app/api/vapp/media/route.js`) fans out two upstream calls in parallel:
   - `{baseUrl}/vapp/user/media?page=...` — paginated list of user's files from PocketBase/R2
   - `{baseUrl}/vapp/user/jobs?perPage=200` — completed generation jobs (to pull STT/transcript data)
4. Each item is mapped to `{ url, type, name, createdAt: mtime, stt? }` and returned.
5. Back in the editor, each raw item is passed through `toUploadItem()` which wraps it into the dual-URL shape above and adds `metadata.vappItem: true`.
6. Results are stored via `setUploads(...)` and `setUploadsLoaded(true)`.

**Tab switching:** `uploadsLoaded = true` prevents any re-fetch when the user clicks away and back to the Uploads panel. Only the **Refresh** button resets it to `false`.

**Pagination:** `fetchPage` loops `hasMore` responses, accumulating all pages before setting the store.

---

### Sort order — latest media first

**Problem:** PocketBase's `created` field reflects when the DB _record_ was inserted, not when the file was actually created. Re-indexing or import jobs can give old files a new `created` timestamp.

**Solution (vapp_server `vapp_server.py`):** The `_ts_from_filename()` utility extracts the Unix timestamp embedded in the filename:

```
vapp_tempuplo_{userId}_{13-digit-ms}_{hash}.ext   → ms timestamp
vapp_TS-{10-digit-s}_...                           → second timestamp
```

The `/vapp/user/media` endpoint returns `mtime = _ts_from_filename(filename) or pb_created`. vapp_higgs passes `mtime` through as `createdAt`. The editor sorts by `createdAt` descending so the newest uploads always appear first.

---

### Manual uploads → R2

**Files:** `src/utils/upload-service.ts` + `vapp_higgs/app/api/vapp/upload/route.js`

When the Upload modal is submitted:

1. `modal-upload.tsx` calls `addPendingUploads` → `processUploads()` in the store.
2. `processUploads` calls `processUpload(id, { file }, callbacks)` → `processFileUpload`.
3. `processFileUpload` checks for `?token=` in the URL. If present (vapp context), it calls `processVappFileUpload`.
4. `processVappFileUpload` POSTs the file as multipart to `{vappHost}/api/vapp/upload?token=...&baseUrl=...`.
5. vapp_higgs route determines media type from `Content-Type`, forwards the file to `{baseUrl}/vapp/upload/{video|audio|image}` with `Authorization: Bearer {token}`.
6. vapp_server saves to R2 via `save_upload_bytes`, returns `{ storage_url: "https://rpublic.tomtap.ai/..." }`.
7. vapp_higgs returns `{ ok, url: storageUrl, type, name }` to the editor.
8. `processVappFileUpload` builds an upload item with `metadata.directUrl = storageUrl` and `url = /api/proxy?url=...`, identical in shape to items fetched from the server.
9. The item is prepended to the `uploads` store and immediately visible at the top of the panel.

If no `?token=` is present (standalone/local mode), the original `/api/uploads/local` path is used unchanged.

---

### Timeline clip thumbnails

**File:** `src/features/editor/timeline/items/video.ts` — `CanvasVideoClip`

- The `CanvasVideoClip` constructor receives the **proxy URL** (from `item.details.src`, which is always the Remotion-safe proxy URL).
- `thumbnailsList()` creates an offscreen `<video>` element and seeks to each timestamp to capture frames.
- **Always seeks explicitly** for every timestamp — skipping the seek when `currentTime` already matches caused black frames because the decoder doesn't guarantee a ready frame without an explicit seek event.
- Seek timeout is 6 s to handle slow CDN responses. Black-frame guard: each `drawImage` is skipped if the video has zero dimensions.

---

### CORS — R2 / CDN reads

On vapp_server startup, `ensure_bucket_cors()` in `vapp_storage.py` applies a CORS policy to the R2 bucket via the S3 API (`PUT /{bucket}?cors`). This allows direct CDN reads (GET/HEAD) from any origin. The policy is applied once per process lifetime via the `_bucket_cors_applied` flag.

---

### File identity — `isVappItem`

`src/features/editor/menu-item/uploads.tsx` uses this check to distinguish vapp items from local uploads:

```typescript
const isVappItem = (u: any) =>
  Boolean(
    u?.metadata?.vappItem ||
    u?.url?.includes("rpublic.tomtap.ai") ||
    u?.url?.includes("/api/proxy?url=")
  );
```

All vapp items (both fetched and freshly uploaded) satisfy `metadata.vappItem = true`. The URL fallbacks cover legacy items that predate the `vappItem` flag.

---

---

## 🎬 Guided Script

Guided Script is a floating, project-level panel that shows the video script as a continuous visual guide while editing. It is **completely independent of clip selection and tab state** — it stays visible regardless of which tab is open or which clip is selected.

---

### How to open

A **📋 Script** button sits in the top-right navbar. Click it to open/close the panel. When segments are loaded, the button shows a count badge and highlights violet.

---

### Architecture

```
navbar.tsx
  └─ ScriptGuideButton        → toggles isOpen in store

editor.tsx
  └─ <ScriptGuidePanel />     → rendered at root level (position: fixed, always on top)

use-script-guide-store.ts     → Zustand store, single source of truth
script-guide-panel.tsx        → panel UI: input, parse, render, drag, resize
```

**Key design decision:** The panel is rendered in `editor.tsx` (not inside any clip control), so it is never unmounted when the user switches tabs, selects a different clip, or opens a modal.

---

### Store — `use-script-guide-store.ts`

| Field | Type | Purpose |
|-------|------|---------|
| `segments` | `ScriptSegment[]` | Parsed segments with computed `startMs`/`endMs` |
| `rawJson` | `string` | Original JSON string (used for project save) |
| `isOpen` | `boolean` | Whether the floating panel is visible |
| `floatPos` | `{ x, y }` | Panel position on screen (drag to move) |
| `panelSize` | `{ width, height }` | Panel dimensions (drag edges to resize) |
| `fontSizeKey` | `"S" \| "M" \| "L"` | Text size inside the panel |
| `activeSegmentIndex` | `number` | Index of the segment matching current player time |
| `isCollapsed` | `boolean` | Header-only mode |
| `showInput` | `boolean` | Whether the JSON textarea is visible |

---

### Panel features

| Feature | How |
|---------|-----|
| **Move** | Drag the header (6-dot grip) |
| **Resize width** | Drag left or right edge |
| **Resize height** | Drag bottom-right corner |
| **Font size** | S / M / L pill buttons in header |
| **Load example** | **E** button fills textarea with sample JSON |
| **Minimize** | **—** button collapses to header-only |
| **Close** | **✕** button, reopen via navbar |
| **Segment click → seek** | Click any segment to seek the player to its start time |
| **Live highlight** | Active segment highlights automatically as player time changes |

---

### JSON format

Paste a JSON array into the panel textarea and click **Parse Script**.

```json
[
  {
    "type": "avatar",
    "time": "0:00 - 0:20",
    "text": "What if one of the simplest health habits was not a new diet...",
    "note": "Intense eye contact, lean slightly forward",
    "mark": "hook"
  },
  {
    "type": "broll",
    "time": "0:20 - 1:00",
    "text": "After you eat, your body starts breaking food into energy...",
    "note": "Calm voiceover pace, no rush",
    "search": ["healthy meal", "walking after eating", "blood sugar"],
    "mark": "context-build"
  }
]
```

#### Fields

| Field | Required | Values | Description |
|-------|----------|--------|-------------|
| `type` | ✅ | `"avatar"` / `"broll"` | Avatar = on-camera talking (bold). B-roll = voiceover + footage (dimmer) |
| `time` | ✅ | `"M:SS - M:SS"` | Segment time range. Used for seek and live highlight |
| `text` | ✅ | string | The spoken script for this segment |
| `note` | optional | string | Director note — tone, camera angle, delivery hint. Shown in italic |
| `search` | optional | string[] | Stock footage keywords (Pixabay/Pexels). Only meaningful on broll segments |
| `mark` | optional | see below | Content psychology label shown as a colored badge |

#### Mark values

| Mark | Badge | When to use |
|------|-------|-------------|
| `hook` | 🎣 HOOK | First 3–5 seconds — must grab attention |
| `open-loop` | ◎ OPEN LOOP | Creates curiosity that keeps viewer watching |
| `context-build` | ▸ CONTEXT | Background / explanation section |
| `pattern-interrupt` | ⚡ PATTERN BREAK | Sudden tone/energy shift to re-engage dropping viewers |
| `payoff` | ✓ PAYOFF | Answers the open loop — the key reveal |
| `retention-peak` | ★ RETENTION | Emotional or surprising high point |
| `cta` | ★ CTA | Like / comment / subscribe / final message |

Most segments have **no mark** — only label the psychologically important moments.

---

### How time parsing works

`time: "1:20 - 2:00"` is split on `-` or `–`, each half parsed:

```
"1:20" → (1 × 60 + 20) × 1000 = 80000 ms
"2:00" → (2 × 60 + 0)  × 1000 = 120000 ms
```

These become `startMs` / `endMs` on each segment. On every animation frame, the player's current time is compared against all segments. The first match sets `activeSegmentIndex` and that segment gets a colored highlight in the panel.

---

### Project save / load

When a project is saved (**Save Project** button), the raw JSON string is written into the project data as `_guidedScript`. When the project is loaded, `_guidedScript` is detected, parsed, and loaded into the store automatically — no manual re-paste needed.

```typescript
// on save (navbar.tsx)
const data = {
  ...stateManager.toJSON(),
  ...(rawJson ? { _guidedScript: rawJson } : {}),
};

// on load (navbar.tsx)
const scriptRaw = project.data._guidedScript as string | undefined;
if (scriptRaw) setSegments(JSON.parse(scriptRaw), scriptRaw);
```

---

### AI system prompt for JSON generation

Use this prompt with any AI (Claude, ChatGPT, Gemini) to generate the JSON from a script + timing table:

```
You are a video script guide generator. I will give you a video script with a timing table.
Output a JSON array only — no explanation, no markdown code block.

Rules:
- One object per timing row
- "type": "avatar" or "broll"
- "time": exact "M:SS - M:SS" from the table
- "text": exact spoken words for that segment
- "note": one short director note (tone, camera, delivery)
- "search": 3–6 stock footage keywords — only on broll segments
- "mark": one of: hook, open-loop, context-build, pattern-interrupt, payoff, retention-peak, cta
  Add mark only to the most important moments. Most segments have no mark.

Output only the raw JSON array. Nothing else.
```

---

### Word-level highlight — approaches tried, problems, and recommended future architecture

#### Context

The Script panel shows a **planned** script with author-estimated timings (e.g. `"0:05 - 0:20"`).
The Guided Text (Transcript) panel shows the **actual** Whisper STT output with exact per-word timestamps.

These two are fundamentally different:
- Whisper text is what the speaker **actually said**, tokenised into segments and words with real clock times.
- Script text is what they **planned to say**, organised into paragraphs with rough time estimates.

The texts are similar but not identical (paraphrasing, filler words, minor rewording). There is no 1-to-1 word mapping available without NLP text alignment.

---

#### Approach 1 — Time fraction (elapsed / paragraph duration)

```
highlightWordIdx = floor((mediaTimeSec - paraStart) / paraDur * wordCount)
```

**Problem:** `paraStart` and `paraDur` are author estimates. If the speaker starts a paragraph 1–2 seconds earlier or later than estimated, the highlight is wrong from the first word. Speech pace is also non-uniform — fast at the start, slow at sentence ends — so the fraction drifts in the middle.

---

#### Approach 2 — Whisper word-count proportion

Collect all Whisper words whose `start` timestamp falls within the paragraph's estimated time window. Find the current word in that list. Map its list-index proportionally to the script paragraph word count.

```
highlightWordIdx = round((curWhisperWordIdx / totalWhisperWordsInWindow) * (paraWordCount - 1))
```

**Problem:** The estimated paragraph time window often doesn't align with the actual Whisper word timestamps. For example, the Whisper segment for paragraph 2 content might start at 4.8 s while the script says the paragraph starts at 5.0 s. Words before 5.0 s are excluded → the window is incomplete → the ratio is wrong. Caused visible "speedy" acceleration in the middle of long paragraphs.

---

#### Approach 3 — Nearest-Whisper-segment anchoring

Find the Whisper segment whose `start` is nearest to `estParaStart` and use that as `realParaStart`. Similarly find `realParaEnd`. Use real anchors for all calculations.

**Problem:** "Nearest start" frequently landed on segment[0] (t=0) for paragraphs 2–8, because segment boundaries don't align with paragraph boundaries. `realParaStart = 0` then collected every Whisper word from the start of the video — completely wrong words for later paragraphs.

---

#### Approach 4 — Single spoken-word lookup

Find the last Whisper word that started at or before `mediaTimeSec` (the currently spoken word, e.g. `"supplement"`). Normalize it. Search for it in the script paragraph words. Pick the occurrence closest to the time-fraction estimate.

**Improvement:** Works well for unique long words. The speaker IS reading the script so the word IS in the paragraph.

**Remaining problem:** Common short words (`"a"`, `"the"`, `"not"`) appear many times; the time-fraction anchor for disambiguation is itself unreliable for the same reasons as Approach 1.

---

#### Approach 5 — Sliding-window segment alignment (current)

Take the entire active Whisper **segment** word list (e.g. 8–12 words). Slide it across the script paragraph word list and count consecutive word matches at each offset. The highest-scoring offset is `segRangeStart`. This gives both:
- `segRangeStart / segRangeEnd` — which words in the script correspond to the current Whisper segment (shown as underline)
- `highlightWordIdx` — the active word within that matched range, using the Whisper word's index inside the segment

**Improvement:** Multi-word matching is far more reliable than single-word lookup. A 4-word match uniquely identifies the position even in long paragraphs.

**Remaining problem:** Still runs the O(n × m) sliding window on **every animation frame** (every 33 ms at 30 fps). Accurate but wasteful. If the transcript or script changes mid-session, the alignment is re-derived from scratch on the next frame.

---

#### Recommended future architecture — pre-computed alignment map

**Core idea:** Run the alignment **once** when transcript + script are both available, store the result, and use O(1) lookups on every frame.

**Step 1 — Build the alignment map** (run when transcript or script segments change):

```typescript
type WordMap = {
  scriptParaIdx: number;
  scriptWordIdx: number;
  whisperSegIdx: number;
  whisperWordIdx: number;
  startMs: number;   // absolute timeline ms (for seeking)
  endMs: number;
};

type ParaMeta = {
  realStartMs: number;   // first Whisper word in this para → absolute ms
  realEndMs: number;     // last Whisper word in this para → absolute ms
  segRanges: Array<{     // each Whisper segment that touches this para
    scriptWordStart: number;
    scriptWordEnd: number;
    whisperSegIdx: number;
  }>;
  wordMap: WordMap[];    // one entry per Whisper word that maps to this para
};
```

For each script paragraph:
1. Use sliding-window alignment (as in current approach) to find where each Whisper segment's words map in the paragraph. Run once, not per frame.
2. Build `wordMap`: for each Whisper word at absolute time T, record which script word index it maps to.
3. Store `realStartMs` and `realEndMs` from the earliest/latest Whisper word found in this paragraph.

**Step 2 — Per-frame lookup (O(1)):**

```typescript
// Binary search wordMap for current mediaTimeSec
const entry = binarySearch(paraMeta.wordMap, mediaTimeSec);
highlightWordIdx = entry?.scriptWordIdx ?? timeFractionFallback;
segRangeStart   = paraMeta.segRanges[entry?.whisperSegIdx]?.scriptWordStart ?? -1;
segRangeEnd     = paraMeta.segRanges[entry?.whisperSegIdx]?.scriptWordEnd   ?? -1;
```

**Step 3 — Persist with project save:**

Add `_guidedScriptMeta: JSON.stringify(alignmentMap)` to the project save payload alongside `_guidedScript`. On load, restore it — no need to re-align if transcript hasn't changed.

**Step 4 — Invalidation:**

Re-run alignment only when:
- `transcript` changes (new STT fetch completes)
- `segments` (script paragraphs) change (user re-parses JSON)

Use a Zustand `alignmentReady` flag. While `false`, show a subtle "syncing…" indicator and fall back to time-fraction highlights.

**Benefits over current approach:**
- Zero per-frame computation — alignment is done once
- Binary search on a sorted array is O(log n) per frame
- More accurate: entire transcript is aligned holistically, not paragraph-by-paragraph in isolation
- Seek-on-click uses `paraMeta.realStartMs` → seeks to actual speech, not estimated time
- Saveable / restorable with project

---

### Relevant files

| File | Role |
|------|------|
| `src/features/editor/store/use-script-guide-store.ts` | Zustand store + time parser |
| `src/features/editor/control-item/script-guide-panel.tsx` | Full panel component |
| `src/features/editor/editor.tsx` | Mounts `<ScriptGuidePanel />` at root |
| `src/features/editor/navbar.tsx` | Script button + save/load integration |

---

## 📝 License

Copyright © 2025 [DesignCombo](https://designcombo.dev/).
