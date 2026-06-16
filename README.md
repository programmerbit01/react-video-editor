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
