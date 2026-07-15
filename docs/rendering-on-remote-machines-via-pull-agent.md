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
| **Local** | browser → same-origin `/api/render*` | the editor you're viewing | quick, single machine |
| **Remote** | browser → another editor's `/api/render*` (URL) | the machine at that URL | one specific remote box |
| **Queue** *(default)* | browser → vApp server `/vapp/render/enqueue` → PB queue → **pull agent** | any free render machine | fleet, concurrency, no URL typing |

**Engine:** `FF` = ffmpeg (`/api/render`, fast, animations limited, real ffmpeg binary).
`RE` = remotion (`/api/render-remotion`, all animations/transitions, headless Chrome).
The queue path carries `options.engine`, so FF/RE both work through the fleet.

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
  `/api/render`, `/api/render-remotion`, `/api/proxy`, `/api/export-timeline` → `:3001`.
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
`patchDesignMetadata` + zip-export, uploads `getPlayerSrc`). `/api/proxy` is now a
minimal dormant shim — it only activates for the legacy Garage host
`vapp-media-gar.tomtap.ai` and ONLY when `NEXT_PUBLIC_LEGACY_GARAGE_PROXY=1`
(default OFF). **Never re-wrap R2 URLs in the proxy.**

### 9.2 Localize prefetch + local asset cache
Before the render, `localizeAssets()` (in `render-remotion/route.ts`) rewrites every
remote asset src → a **local cache route** `/api/asset-cache/[key]` and warms the cache.
The render then reads all media from localhost = no per-asset R2 stalls; **re-renders
reuse the cache instantly** (`✓ cached`). Cache lives on the **render machine**
(populated at render time). Store: `src/utils/asset-cache-store.ts` (`.asset-cache/`,
LRU `ASSET_CACHE_MAX_GB` default 40, key by pathname so presigned `?X-Amz-…` doesn't
defeat reuse; **in-flight dedup** so the warm + a cache-through never double-pull).

**Download-all-first is the DEFAULT (safe).** Remotion renders frames in **parallel
across the whole timeline**, so the render can request ANY asset at any moment — if it
outruns the download on a slow uplink, a frame's `<Img>` hits the `delayRender` timeout
and the whole render **FAILS** (`… was called but not cleared after Nms`). So we download
everything first, then render. **Overlap** (render-while-downloading, total ≈
`max(download,render)`) is **opt-in via `RENDER_LOCALIZE_OVERLAP=1`** — only safe on a
fast/datacenter link. The `/api/asset-cache` cache-through route is a safety net either
way. Toggles: `RENDER_LOCALIZE=0`, `RENDER_LOCALIZE_OVERLAP=1`, `RENDER_LOCALIZE_CONCURRENCY`.

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
> break this — a clean full deploy avoids it. Legacy Garage-host assets need
> `NEXT_PUBLIC_LEGACY_GARAGE_PROXY=1` or migration to R2.

### 9.9 Quick failure → cause map (additions)
| Symptom | Likely cause |
|---|---|
| Render stuck at ~65% with no error | (pre-fix) asset download stall via proxy — now direct + localized; check the stall banner + logs |
| `Localize assets` errors `✕ … (cache-through)` | that asset wasn't prewarmed; served direct from R2 — harmless |
| `NVENC path failed — falling back…` | frame glob / ffmpeg / no nvenc — using libx264; safe |
| Agent reports `R2 upload ok` not `R2 multipart ok` | server multipart endpoints unreachable (old vApp) — single-PUT fallback |
| Some old-project asset fails to load (CORS) | it's on the legacy Garage host — set `NEXT_PUBLIC_LEGACY_GARAGE_PROXY=1` or migrate |
