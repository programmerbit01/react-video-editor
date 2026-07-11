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
