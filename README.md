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

## 📝 License

Copyright © 2025 [DesignCombo](https://designcombo.dev/).
