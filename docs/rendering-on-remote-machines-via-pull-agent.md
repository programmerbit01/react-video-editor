# editor: rendering on remote machines via pull agent

A self-hosted "Remotion-Lambda" for the editor: queue a video render, and any free
render machine on the fleet picks it up, renders it, uploads the MP4, and reports
live progress + metrics + logs back to the browser — no tunnels, no hardcoded URLs,
no paid service.

---

## 1. The three ways to render

The Download panel exposes three targets (tabs). All three share the same export
settings (format / resolution / quality / **FF vs RE engine**).

| Way | Path | Where it renders | When to use |
|-----|------|------------------|-------------|
| **Local** | browser → same-origin `/editor/api/render*` | the editor you're viewing | quick, single machine — **and the way to debug the queue** |
| **Remote** | browser → another editor's `/editor/api/render*` (URL) | the machine at that URL | one specific remote box |
| **Queue** *(default)* | browser → vApp server `/vapp/render/enqueue` → PB queue → **pull agent** | any free render machine | fleet, concurrency, no URL typing |

**Engine:** `FF` = ffmpeg (`/api/render`, fast, animations limited, real ffmpeg binary).
`RE` = remotion (`/api/render-remotion`, all animations/transitions, headless Chrome).
The queue path carries `options.engine`, so FF/RE both work through the fleet.

### Local and Queue end at the same handler — use that

The agent posts `{service_url}/api/render`, where `service_url` already ends in `/editor` — i.e.
`/editor/api/render`, with the same `{design, options}` body. **Local now posts to exactly that
path.** So a Local export exercises the same route a queued job triggers, minus the agent: debug
Local first, and what you fix is what the fleet runs.

Local used to send a bare `/api/render`, which is *not* where the route lives — the editor runs
under `basePath: '/editor'`. It only worked because higgs rewrites that one string. Verified
against an editor with no higgs in front of it: `POST /api/render` → **404** (never reached the
route), `POST /editor/api/render` → **400 "design required"** (handler reached). Opening the editor
directly on `:3001` and hitting Local silently 404'd.

---

## 2. Components & who talks to whom

```
              ┌──────────── browser (editor UI) ────────────┐
              │  launched as: /editor?vappHost=..&token=..   │
              │              &baseUrl=<vApp server>          │
              └───────┬─────────────────────────┬───────────┘
                      │ Local/Remote            │ Queue (DIRECT, no proxy)
                      │ (same/other editor)     │
                      ▼                         ▼
        /api/render (FF)              POST {baseUrl}/vapp/render/enqueue
        /api/render-remotion (RE)     GET  {baseUrl}/vapp/job/status   (modal poll)
                                      GET  {baseUrl}/vapp/renders      (widget poll)
                                             │
                                             ▼
                                   ┌──────── vApp server (:8091) ────────┐
                                   │  enqueue → vapp_jobs (PocketBase)   │
                                   │  /vapp/job/report  (agent → here)   │
                                   │  /vapp/renders     (widget source)  │
                                   └───────────────┬─────────────────────┘
                                                   │ pull
                                                   ▼
                                   ┌──────── pull agent (render box) ────┐
                                   │  claims render job                  │
                                   │  POST 127.0.0.1:3001/editor/api/... │
                                   │  polls /{id}, downloads the MP4     │
                                   │  uploads to source R2, reports back │
                                   └─────────────────────────────────────┘
```

**Ports on a render box:**
- `:3000` = **higgs** (Next 15) — serves the editor at `/editor` by rewriting `/editor/*`,
  `/api/render`, `/api/render-remotion`, `/api/export-timeline` → `:3001`.
- `:3001` = **editor** (react-video-editor, Next 16, `basePath: /editor`) — does the actual render.

**Hard rule:** the pull agent and the editor it drives are on the **same machine** — the
agent calls `http://127.0.0.1:3001/editor/api/render*`. Only the agent can reach that local
editor, so post/poll/download **must** live in the agent. The vApp server can be central.

---

## 3. Queue render — end-to-end sequence

1. **Enqueue** — browser POSTs `{design, options}` to `{baseUrl}/vapp/render/enqueue`.
   Server creates a `vapp_jobs` record `type=render, model=remotion` (503 if no online
   render agent). Returns `{job_id, status:"queued"}`.
2. **Claim** — a pull agent advertising a `render`/`remotion` capability claims the job.
3. **Render** — the agent picks the route from `options.engine`
   (`ffmpeg → /api/render`, else `/api/render-remotion`), POSTs `{design, options}` to its
   **local** editor, gets a render id, and polls `/{id}`.
4. **Report (live)** — every tick the agent forwards the **raw editor `render` object**
   (progress + gpu/cores/speed/log/…) to `/vapp/job/report`. The server stores it on the job.
5. **Download + upload** — on `COMPLETED` the agent downloads `/{id}/download` (the MP4 bytes)
   and uploads to the **source vApp's** R2, then reports `completed` with the result URL.
6. **Surface** — the browser's Download **modal** polls `/vapp/job/status` (progress + metrics
   live). The floating **Exports widget** polls `/vapp/renders`, which also lists
   `type=render` PB jobs so queue renders show cross-machine.

---

## 4. The thin-agent principle

> The agent is a **light layer**. Major control lives in the **vApp server**.

The agent does only what physically requires being on the render box:
**post → poll → download → upload → report**. It forwards the **whole raw editor render
object** as `result.metrics`; the vApp server extracts progress / metrics / logs and shapes
`/vapp/renders`. The browser's `pickMetrics` selects the fields it needs.

**Why:** any future metric / log / format change is then a **vApp-server-only** change
(central `git pull`) — no per-machine agent edit or restart. The agent stays frozen.

---

## 5. Key files

**editor (react-video-editor)**
- `src/app/api/render-remotion/route.ts`, `.../[id]/route.ts`, `.../[id]/download/route.ts` — RE render + status + download
- `src/app/api/render/route.ts` (+ `[id]`, `[id]/download`) — FF (ffmpeg) render, same shapes
- `src/app/api/render-jobs/route.ts` — proxies `/vapp/renders` for the widget
- `src/features/editor/store/use-download-state.ts` — `startExport` (local/remote) + `startQueueExport` + `RenderMetrics`/`pickMetrics`
- `src/features/editor/navbar.tsx` — Download panel (3 tabs), project import/export, chips
- `src/features/editor/download-progress-modal.tsx` — modal + minimized navbar chip
- `src/features/editor/render-status-widget.tsx` — Exports widget (navbar chip → floating panel)

**vApp server**
- `vapp_server.py` — `POST /vapp/render/enqueue`, `/vapp/render_callback`
- `vapp_server_mcp.py` — `GET /vapp/renders` (widget; also lists `type=render` PB jobs)
- `vapp_pull/__init__.py` — `enqueue_job`, `_has_online_agent_for`, `_pb_list`, `/vapp/job/report`, `/vapp/job/status`

**pull agent** (on the render box; deployed there, not from the editor repo)
- `vapp_agent/__init__.py` — `render_adapter` (thin), `ADAPTERS["render"]`
- `config.json` — capabilities incl. `{type:"render", model:"remotion", service_url:"http://127.0.0.1:3001/editor", backend:"render"}`

---

## 6. Common mistakes & gotchas (learned the hard way)

**Agent / worker**
- **Code change ⇒ RESTART the agent.** Saving config via the agent GUI (`/admin/config`)
  hot-reloads only the *config* (capabilities/URLs), **not** Python code. New `render_adapter`
  logic needs a real process restart (systemd). `Restart=always` + killing the process is a
  no-sudo way to restart.
- **Capability ≠ adapter.** Adding `type=render` in the GUI only *advertises* it. The agent
  code must actually contain a `render` adapter, or jobs fail with *"no adapter for … render"*.
- **No capability ⇒ 503** *"no machine is available for this model"* from `/vapp/render/enqueue`
  (`_has_online_agent_for("remotion")` is false). `model` must match exactly (`remotion`).
- **Right editor port.** `service_url` must point at the **editor** (`:3001/editor`), not higgs
  (`:3000`). Both proxy the render routes, but the internal origin / download path assume `:3001`.
- **One machine, one agent.** An agent renders only on *its* local editor. Multiple render
  boxes each need their own agent + editor + capability.

**Callbacks / double work**
- **`skipCallback`.** The editor render route also fires its *own* `register_render_job` +
  `render_callback` (for the local push-render widget). In pull mode that **double-uploads** to
  the wrong (local) vApp. Keep `skipCallback:true` so the agent owns upload+report. Consequence:
  queue renders don't self-register in the local widget → surface them by listing `type=render`
  PB jobs in `/vapp/renders` instead (do **not** drop skipCallback to "fix" the widget).

**Widget / browser**
- **basePath.** The widget fetches `${NEXT_PUBLIC_BASE_PATH}/api/render-jobs`. If that env is
  empty in the build, it hits `/api/render-jobs` (no `/editor`) → higgs has no such rewrite →
  `000/404` → empty widget. Local renders would break the same way. Fix the build's basePath.
- **Cross-machine widget.** Queue renders run on the render box but must appear on the **source**
  editor. The widget polls the *source* vApp's `/vapp/renders`; that endpoint must include the
  source PB's `type=render` jobs (not just the in-memory `render_jobs` push map).
- **Two widgets.** Historically the editor's *Exports* widget and higgs's *AI Renders*
  (`RenderStatusBar`) both showed. Keep one (the editor's); unmount the higgs one from
  `StandaloneShell`.

**Browser ↔ vApp server**
- **DIRECT, no proxy.** Queue enqueue + modal poll go straight to `{baseUrl}/vapp/...` with
  `Authorization: Bearer <token>`. Don't route through the higgs `/api/vapp/*` proxy.
- **`baseUrl` is required.** The editor must be launched with `?baseUrl=<vApp server>&token=…`
  (same as uploads / AI-voice). Opening a bare editor URL → `startQueueExport` throws
  *"No vApp server"*. `baseUrl` must be the **public** vApp, never a private LAN IP.
- **CORS.** The vApp server has a global `CORSMiddleware`; the editor's `next.config` adds CORS
  headers to `/api/render*` for cross-origin *remote* renders. New endpoints inherit the middleware.

**Engine specifics**
- **Logs are FF-only.** The ffmpeg route builds a `log` array (setup / per-clip / encoder / done);
  the remotion route doesn't expose one. So *"show logs"* appears on **FF** renders, not RE.
- **Live metrics timing.** RE sets `gpu/cores/cc` early (progress ~15) so they stream live;
  FF sets its metrics only at completion. Both show the full summary when done.
- **`Internal Server Error` on `/editor`.** Usually the editor process (`:3001`) is **down** while
  higgs (`:3000`) is up — higgs can't reach its rewrite target. Start/restart the editor service.

---

## 7. Deploy checklist

Per host, the editor + higgs + vApp server are git repos:
```bash
# editor host (and any render box's editor)
cd react-video-editor && git pull && npm i && rm -rf .next && npm run build && <restart editor svc>
# higgs host
cd vapp_higgs && git pull && npm run pull:all && npm i && rm -rf .next && npm run build && <restart higgs svc>
# vApp server host (the one the browser's baseUrl points at)
cd vapp_server && git pull && <restart vapp_server>
```
- **Pull agent** lives on the render box and is deployed/edited there directly. A **code** change
  needs an agent **restart**; a capability change can be saved live via its GUI.
- After a frontend build, **hard-refresh** the browser (cached bundle).

---

## 8. Quick failure → cause map

| Symptom | Likely cause |
|---|---|
| `no machine is available … (code)` on enqueue | no online agent advertising `render`/`remotion` (add capability + restart) |
| `no adapter for … render` | agent code lacks the `render` adapter (deploy + restart) |
| Queue renders but modal shows no metrics | agent not forwarding / stale agent code — restart |
| Widget empty for queue renders | `/vapp/renders` not listing `type=render` PB jobs, or wrong `baseUrl`/basePath |
| `No vApp server` on "Send to Render Queue" | editor opened without `?baseUrl=` |
| `/editor` → `Internal Server Error` | editor `:3001` process down (higgs up) — restart editor |
| FF selected but renders RE (or vice-versa) | queue path ignored `options.engine` — ensure agent routes by engine |
| Double upload / stray render-library entry | `skipCallback` not set in pull mode |

---

## 9. Speed + observability overhaul (2026-07-15)

A pass on the **RE (remotion) queue render** path took an 11-min / 190-item project
from **0.36× → 1.29× realtime** and its output from **1.2 GB → ~400 MB**, while making
the render fully observable. All of the below apply to **every** render on the RE
route — GUI (Local / Remote / Queue) *and* MCP/AI renders (same `runRemotionExport`).

### 9.1 Direct asset URLs (no proxy)
Assets load **DIRECT from R2** (`rpublic.tomtap.ai` serves CORS `*`) — each render
worker pulls R2 in parallel = fast. A same-origin `/api/proxy` hop only serializes
everything through one Next process = slow ("proxy shit"). Single source of truth:
`src/features/editor/utils/asset-url.ts` → `resolveAssetUrl()` (unwraps legacy
`/api/proxy?url=` baked into old/imported designs → direct; used in navbar
`normalizeProject` in `project-schema.ts` + zip-export, uploads `getPlayerSrc`).
`/api/proxy` is **deleted**. It was kept as a dormant shim for the legacy Garage host
`vapp-media-gar.tomtap.ai`, said to lack a CORS preflight — that host answers
`access-control-allow-origin: *`, so the shim's one reason was never true and it had
been off by default anyway. **Never re-wrap R2 URLs in a proxy.**

### 9.2 Localize prefetch + local asset cache
Before the render, `localizeAssets()` (in `render-remotion/route.ts`) rewrites every
remote asset src → a **local cache route** `/api/asset-cache/[key]` and warms the cache.
The render reads media from localhost = no per-asset R2 stalls; **re-renders reuse the
cache instantly** (`✓ cached`). Cache lives on the **render machine** (populated at render
time — so a re-render on a DIFFERENT worker starts cold). Store:
`src/utils/asset-cache-store.ts` (`.asset-cache/`, LRU `ASSET_CACHE_MAX_GB` **default 20**,
key by pathname so presigned `?X-Amz-…` doesn't defeat reuse; **in-flight dedup** so the
warm + a cache-through never double-pull; no TTL — evicts oldest only when over cap).

**OVERLAP is the DEFAULT** (render starts immediately, cache warms in the background).
Remotion renders frames in **parallel across the whole timeline**, so a frame can request
an asset that's still downloading — the `/api/asset-cache` cache-through route serves it
from R2 on demand and the frame **WAITS** (up to `RENDER_ASSET_TIMEOUT_MS`, default **600s**)
instead of failing `delayRender … not cleared after Nms`. So total ≈ `max(download, render)`
with no up-front wait and no timeout fail. (Earlier a 120s timeout made overlap FAIL on a
slow uplink — hence the long asset timeout.) Opt out to strict download-all-first with
`RENDER_LOCALIZE_OVERLAP=0`. Toggles: `RENDER_LOCALIZE=0`, `RENDER_LOCALIZE_OVERLAP=0`,
`RENDER_LOCALIZE_CONCURRENCY`, `RENDER_ASSET_TIMEOUT_MS`.

### 9.3 Observability (stages / logs / stall / fps)
`render-remotion/route.ts` now writes per-stage timers (**Bundle → Localize → Prepare
→ Render frames → Encode**) + a rolling `log[]` + a **stall watchdog** (flags + logs
`⚠ STALL — no frame for Ns` after `STALL_AFTER_MS=90s`; skips once all frames are
rendered so Encode doesn't false-stall) + **instantaneous fps** + `onDownload` /
`onBrowserLog` capture. Surfaced via `[id]/route.ts` GET → store → the reporting card.

### 9.4 One reporting module
`render-report-types.ts` (pure, server-safe types/helpers + `pickMetrics`) +
`render-report.tsx` (`RenderReportRow`). BOTH the Download modal and the Exports
widget render the SAME row — identical stats, stages, logs. Edit reporting once here.

### 9.5 CRF (output size)
RE passed NO crf → Remotion's default made a ~1.2 GB near-lossless file. Now
`CRF_BY_QUALITY {high:20, medium:24, low:28}` (visually lossless, ~⅓ the size, faster
encode + upload). Reported as `CRF 20 · 1080p` in the card.

### 9.6 NVENC (opt-in, NVIDIA boxes)
Remotion 4.x has NO nvenc (only macOS VideoToolbox) — its Linux encode is CPU libx264.
So where the system ffmpeg supports nvenc it switches to: Remotion `renderFrames`
(all animations) → JPEG sequence + `renderMedia codec:wav` (audio) → the **system
ffmpeg's `h264_nvenc`** combines them. **AUTO-DETECTED** (like the GPU GL backend) — a
one-time ffmpeg probe; if it can nvenc, use it, else standard `renderMedia`. No manual
flag; force off with `RENDER_NVENC=0`. **Any failure falls back to `renderMedia`**, so
it can only help. Pair with `REMOTION_CONCURRENCY=24` (more cores → faster frames — the
bigger cost). Verify on the box (`NVENC auto-detect: available ✓` log).

### 9.7 Pull agent (deployed per render box — see its own repo)
- **Poll-retry:** a status-poll timeout no longer fails the job (a fast CPU-saturated
  render starves the editor's Node loop). Retries (60s timeout, up to 12×).
- **S3 multipart output upload:** files >20 MB split into parts, PUT in **parallel**
  (conc 4) via the server's **already-existing** agent-trusted endpoints
  `/vapp/presign-multipart-{start,complete}`. Falls back to single PUT on any error.
  Env: `VAPP_MULTIPART`, `VAPP_MULTIPART_CONCURRENCY`, `VAPP_MULTIPART_MIN_MB`.
- **Upload visibility:** the download-from-editor + R2 upload (the "98% tail") report
  size/speed into the modal log (`⬆ uploaded X MB in Ys (Z MB/s)`).

### 9.8 Deploy rule (avoid mismatch drama)
> Per render box: deploy the **editor** (build + restart) AND the **agent** (restart)
> **together**. Keep the vApp server (presign-multipart endpoints) current. A box with
> a new editor but no `/api/asset-cache` route, or an old agent, is the only way to
> break this — a clean full deploy avoids it.

### 9.9 Quick failure → cause map (additions)
| Symptom | Likely cause |
|---|---|
| Render stuck at ~65% with no error | (pre-fix) asset download stall via proxy — now direct + localized; check the stall banner + logs |
| `Localize assets` errors `✕ … (cache-through)` | that asset wasn't prewarmed; served direct from R2 — harmless |
| `NVENC path failed — falling back…` | frame glob / ffmpeg / no nvenc — using libx264; safe |
| Agent reports `R2 upload ok` not `R2 multipart ok` | server multipart endpoints unreachable (old vApp) — single-PUT fallback |
| Any asset fails to load (CORS) | check the R2 bucket's CORS policy FIRST — it should be `*`. An origin is an exact string (`http://host` ≠ `http://host:3000`), R2 rejects partial wildcards, and a per-origin ACAO gets cached per origin — we measured a 2-day-old header served for an origin already removed. Bust the cache before believing any test. |

---

## 10. Editor fixes (2026-07-15, same pass)

Beyond rendering, a sweep of editor/timeline bugs (from a 3-way code scan):

**Timeline**
- **Scatter on zoom** — `getZoomByIndex(-1)`→`undefined` scale → NaN item left/width →
  items collapsed to the origin. Clamped `getZoomByIndex` + restored the (commented-out)
  clamp in `getFitZoomLevel` (`utils/timeline.ts`).
- **Captions on ONE row** — per-clip `captions-track--<clipId>` tracks are merged into a
  single caption track (they're time-positioned so each still sits under its clip).
  Handled in load (`patchDesignMetadata`), create (`applyCaption` + ai-edit `addCaptions`
  reuse the shared track) and remove (drop only this clip's items; track only when empty).
- **Captions follow their clip on move** — `hooks/use-caption-sync.ts`: captions carry
  `metadata.relFrom/relTo` (offset from the clip's start); on any `trackItemsMap` change a
  caption is shifted to `clipFrom + relFrom`, so moving a clip drags its captions. No
  update loop (drift→0); `updateHistory:false`.
- **Black thumbnails that stick** — `timeline/items/video.ts` skips undecoded
  (`readyState<2`) and near-black frames BEFORE caching (they were persisted to IndexedDB
  forever); nudges t=0 so a `seeked` fires; adds `img.onerror` so a bad blob can't hang the
  filmstrip. **Black preview** — player `OffthreadVideo` src now goes through `resolveAssetUrl`.
- **Click a clip → playhead + preview seek to it** (`editor.tsx`, on `activeIds` change).
- **Row heights** — video/image 50px, caption 24px (`sizesMap` + `track-controls-overlay ROW_H`).

**Uploads** — `utils/vapp-upload-client.ts` downscales images to WebP ≤1920px before the
R2 PUT (`NEXT_PUBLIC_UPLOAD_IMG_MAX_DIM`). A 10MB PNG → ~0.4MB (huge PNGs were the real
"render download is slow" cause). Studios have their own WebP step in `vapp_higgs`; that
still lacks a downscale — a separate follow-up.

**UI** — light-theme active sidebar tab was `text-white` (invisible) → theme-aware
`text-foreground`; navbar dropdowns (Download etc.) raised to z-10000+ so they sit ABOVE
the AI Edit / Script floating panels (z-9999); AI Edit settings popover closes on
outside-click.

---

## 11. Render engine fixes (2026-07-15, pass 2)

Three concrete render failures, one per engine path:

**RE (Remotion) NVENC — audio pass hang** (`api/render-remotion/route.ts`)
The NVENC path renders JPEG frames, then a *separate* `renderMedia({ codec: "wav" })`
pass to extract the soundtrack, then muxes both with `h264_nvenc`. That audio pass
re-evaluates the WHOLE composition — on a big timeline (190+ images/captions) headless
Chrome re-loads every visual just to emit silence for it, stalling for minutes (seen
stuck at 84%). Fix: `audioOnlyDesign()` trims the design to just the sound-bearing items
(`audio` + `video`; visuals/transitions dropped, duration/size preserved) and feeds THAT
to the WAV pass — identical audio, a fraction of the work. If the timeline has no sound
at all, the pass is skipped and ffmpeg encodes with `-an`. **NVENC itself is unchanged.**

**FF (ffmpeg) — `spawn E2BIG` on big timelines** (`api/render/route.ts`)
A timeline with dozens of Ken Burns / caption `zoompan` nodes builds a `filter_complex`
graph of tens/hundreds of KB. Passed inline as one argv value it exceeds the OS limit
(Linux `MAX_ARG_STRLEN` 128KB per arg; macOS `ARG_MAX` 256KB total) → `spawn E2BIG`, the
whole export crashes before ffmpeg even starts. Fix: write the graph to `filtergraph.txt`
in the job tmp dir and reference it with `-filter_complex_script` — argv stays tiny
regardless of item count. (`-filter_complex_script` verified on ffmpeg 8.1.1.)

**FF — silent download failures** (`api/render/route.ts`)
When media couldn't be fetched, FF logged only `Could not download any media files` with
no clue why. Now each failed download logs its URL + reason to the job log
(`⬇ failed [video] <url> — HTTP 403`), plus a `downloaded X/Y (Z failed)` summary, and
the final error names the count. Srcs are also run through `unwrapProxyMediaUrl` before
fetch (the RE path already did this) so legacy `/api/proxy?url=…` wrappers resolve to the
real asset instead of 404-ing. A dead/expired/private source URL is now visible in the
export report instead of a mystery failure.

> Deploy: these are editor-source changes. The machine that actually renders (NVENC runs
> only on the GPU box) needs `git pull → npm run build → restart` to pick them up — a bare
> `next start` restart does not recompile source.
