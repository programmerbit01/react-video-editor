# Project Persistence — auto‑saved, versioned project JSON (editor · MCP · render)

> **Status: PLAN / SPEC.** Blueprint for the full store. Goal: **any** tool that edits or
> renders a video (editor, AI Edit panel, MCP, Dify, vidrush, render) writes the **same project
> JSON** to **one shared, versioned store**, so opening a project restores the **full timeline**
> (as the editor already does) and you can **revert / resume from any point**.

> **✅ SHIPPED (2026‑08‑03) — server‑backed, per‑user project storage (localStorage removed).**
> Projects now persist on the vApp server in **PocketBase `vapp_jobs` as `type="project"` rows** —
> one row per project, keyed by `user_id` + `job_id=<projectId>`, with `input={name,savedAt,data}`.
> This **replaces browser localStorage** (`vapp_saved_projects`), which was throwing
> `QuotaExceededError` once a handful of projects piled up. **Save, load, update (upsert), autosave,
> delete and import** all go through the server, and projects are **user‑scoped — no user ever sees
> another's**. Media stays on **R2** exactly as the design already references it; only the reference
> JSON is stored. A **one‑time migration** pushes any pre‑existing localStorage projects up on first
> load so nothing is lost.
>
> **Deliberate deviations from §5/§6 below** (product call): we **reused the existing `vapp_jobs`
> collection** with a `type="project"` discriminator instead of a **new `vapp_projects`** collection,
> and did **NOT** build per‑save **versioning** — save is **last‑write‑wins upsert** (PATCH the same
> row by `job_id`). Endpoints shipped: **`GET/POST/DELETE /vapp/editor-projects`** (`vapp_server.py`),
> resolving the caller via `_api_user` (Bearer token from the editor's `?token=`) — NOT the versioned
> `/vapp/projects` spec. Writes use raw `_pb_call` (no job‑SSE spam on autosave); rows carry a terminal
> `status` and startup cleanup skips `type="project"`, so a saved project is **never purged**. The
> versioned store, render→project link and MCP/Dify unification in §5–§13 remain the (optional) fuller
> roadmap. **Files:** `vapp_server/vapp_server.py`, editor `api/vapp-projects/route.ts`,
> `utils/project-storage.ts`, `navbar.tsx`.

> **✅ Partially shipped (2026‑07‑12)** — the MCP slice of §8/§9: **every MCP render/assemble now
> ALWAYS saves an editor project** (auto‑unique name when none given) so it shows in the editor's
> **AI Projects** list and restores the full timeline on select. `_render_design` + the
> `assemble_timeline` preview branch save made **unconditional** (`vapp_server_mcp.py`); the editor
> navbar now **refreshes** an AI project when the server copy is newer (was: skipped → stale
> timeline on re‑render). **Editor autosave (P1) shipped:** an open project (opened/saved OR
> AI/MCP) now auto‑saves to localStorage on every timeline change (debounced 2.5s) via a
> `useStore.subscribe` hook in `navbar.tsx` → manual **and** AI‑Edit edits are never lost, reopen
> restores. Still TODO: the shared **versioned** PB store (cross‑device + version‑revert), autosave
> for FRESH unsaved projects, + render‑enqueue → project link.

---

## 1. TL;DR

- The canonical timeline JSON already exists (`stateManager.toJSON()` = the **design**), and
  **`DESIGN_LOAD` already restores the whole timeline from it**. Render and MCP already emit
  the *same* shape. So **format/restore is solved** — the gap is **storage + autosave + versioning**.
- Add **one shared vApp project store** (versioned, keyed by `project_id` + `user_id`).
- Make every producer write the **same envelope** to it: editor autosave, render‑enqueue, MCP/Dify/vidrush.
- Revert/resume = load an older **version** through the existing `DESIGN_LOAD` path.
- Additive / strangler: today's localStorage save stays; the server store is added *alongside*.

---

## 2. What already works (do NOT rebuild)

| Piece | Where | Note |
|---|---|---|
| Canonical timeline JSON = **design** | `stateManager.toJSON()` (`@designcombo/state`) | `{ id, size{w,h}, fps, duration, tracks[], trackItemIds[], trackItemsMap{}, transitionIds[], transitionsMap{}, metadata{} }` |
| **Open → full timeline restore** | `navbar.tsx:236 handleLoadProject` → `dispatch(DESIGN_LOAD, patchDesignMetadata(project.data))` | **`DESIGN_LOAD` is the ONE code path that fills the timeline from JSON.** Reuse it, don't add another. |
| Manual save (user) | `navbar.tsx:190 handleSaveProject` → `stateManager.toJSON()` + inject extras → `saveProject()`/`updateProject()` | Stored in **browser localStorage** `vapp_saved_projects` (`utils/project-storage.ts`). |
| Render carries the **same** design | `navbar.tsx:557/571/581/794` build `{ id, ...stateManager.toJSON() }` | Identical shape to a saved project's `data`. |
| MCP emits the **same** design | `vapp_server_mcp.py` (`trackItemsMap`/`tracks`/`trackItemIds` builder ~`:1693`, `_normalize_design:1049`) | `DESIGN_LOAD` consumes it as‑is → opens fine. |
| Editor lists MCP projects | `api/vapp-projects/route.ts` (GET‑only) → vApp `GET /vapp/projects` (`vapp_server_mcp.py:859`) | Lists `editor_projects/*.json` as `ai_*`; merged into the navbar list (`navbar.tsx:143`). |

**SavedProject envelope** (editor's wrapper around a design):
```jsonc
{ "id": "project_<ts>", "name": "My Video", "savedAt": "<iso>",
  "data": {  /* the design */
    "size": {...}, "fps": 30, "duration": 12345,
    "tracks": [...], "trackItemIds": [...], "trackItemsMap": {...},
    "transitionIds": [...], "transitionsMap": {...},
    "metadata": { "look": {...}, "stylePack": {...} },   // editor‑only extras
    "_guidedScript": {...}                                // editor‑only extra
  } }
```

---

## 3. The gaps (why "auto‑save + revert from anywhere" doesn't happen today)

1. **Three siloed stores, none shared:**
   - User projects → **browser localStorage** only (device‑local; server/MCP can't see them).
   - MCP/AI projects → **server files** `vapp_server/editor_projects/<name>.json`.
   - Render designs → buried in **`vapp_jobs.input.design`** (a *job* row, not a project).
2. **No autosave.** Project is saved **only** on the manual Save button. Live user edits *and*
   AI‑Edit‑panel edits are never captured unless the user clicks Save.
3. **Render doesn't persist a project.** Queue/local/remote renders carry the full design but
   drop it (or bury it in a job row). Only MCP saves — and only when `project_name` is passed.
4. **No identity / versioning.** Keyed by *name*; saving the same name **overwrites** the file
   (`vapp_server_mcp.py:1831/1909` truncate‑write) → no history, no revert/resume, no stable id
   shared across editor ↔ MCP ↔ render, no `user_id` scoping.
5. **Revert is edit‑scoped, not project‑scoped.** `operations.ts captureSnapshot:349 / revertSnapshot:358`
   only snapshot the `trackItemsMap` entries one AI‑edit message touched — a **live in‑session undo**,
   independent of save/load. It cannot restore a past project state after reload. (Keep it — see §8.)

---

## 4. Target architecture

```
        ┌────────── producers (all emit the SAME design JSON) ──────────┐
        │  Editor (user edits + AI Edit panel)                          │
        │  Render enqueue  ·  MCP  ·  Dify  ·  vidrush                   │
        └───────────────────────────┬──────────────────────────────────┘
                                     │  POST /vapp/projects  (upsert → new VERSION)
                                     ▼
                    ┌──────────────────────────────────┐
                    │  Shared vApp PROJECT STORE        │   single source of truth
                    │  PocketBase `vapp_projects`       │   keyed: project_id + user_id
                    │  every save = an append‑only      │   → history / revert / resume
                    │  VERSION (no overwrite)           │
                    └───────────────┬──────────────────┘
                                    │  GET /vapp/projects[/{id}[/versions[/{v}]]]
                                    ▼
        Editor navbar  ──(pick project / version)──▶  dispatch(DESIGN_LOAD)  ──▶  full timeline
```

**Principle:** one store, one envelope, one restore path (`DESIGN_LOAD`). Producers change *nothing*
about the JSON shape — they just POST it to the shared store.

---

## 5. Data model (proposed PocketBase collection `vapp_projects`)

| field | type | note |
|---|---|---|
| `id` | text (PB id) | version‑record id |
| `project_id` | text (indexed) | **stable** project identity, shared across editor/MCP/render |
| `user_id` | text (indexed) | scoping |
| `name` | text | display name |
| `version` | number | monotonic per `project_id` (1,2,3…) |
| `data` | json | the **design** (+ editor extras) — verbatim `SavedProject.data` |
| `source` | text | `editor` \| `ai-edit` \| `render` \| `mcp` \| `dify` \| `vidrush` |
| `render_job_id` | text (opt) | set when a render produced this version → links job ↔ project |
| `parent_version` | number (opt) | which version this was derived from (branch/revert lineage) |
| `created` | date | PB auto |

> **"latest"** = highest `version` for a `project_id`. Revert = load an older `version`.
> Retention (optional): keep last N + all render/named versions; prune the rest.

**Why PB, not files:** `vapp_jobs` is already PB; versions as rows give querying, `user_id`
scoping, and history for free (the current `editor_projects/*.json` overwrites and has no versions).

---

## 6. New vApp endpoints (spec)

| Method · path | Body / params | Returns | Purpose |
|---|---|---|---|
| `POST /vapp/projects` | `{ project_id?, user_id, name, data, source, render_job_id? }` | `{ ok, project_id, version }` | **Upsert a new version.** New `project_id` if omitted. Append‑only. |
| `GET /vapp/projects` | `?user_id=` | `[{ project_id, name, latest_version, savedAt, source }]` | List (latest per project). **Extends** today's GET (`vapp_server_mcp.py:859`). |
| `GET /vapp/projects/{project_id}` | — | `{ project_id, name, version, data }` (latest) | Open latest → editor `DESIGN_LOAD`. |
| `GET /vapp/projects/{project_id}/versions` | — | `[{ version, savedAt, source, render_job_id }]` | Version history for the revert UI. |
| `GET /vapp/projects/{project_id}/versions/{v}` | — | `{ version, data }` | Load a specific version → revert/resume. |

Fail‑open on the editor side: if POST fails, keep the localStorage save (never block editing).

---

## 7. Editor changes (frontend)

1. **`src/app/api/vapp-projects/route.ts` — add `POST`** (currently GET‑only): forward the
   SavedProject envelope to vApp `POST /vapp/projects` (direct, no proxy). Keep GET.
2. **Autosave hook** — reuse `buildProjectData()` (`navbar.tsx:268`) behind a **debounce on
   timeline‑store changes** (`useStore` → `trackItemsMap / trackItemIds / tracks / size / fps / duration`),
   mirroring the existing `debouncedSetProjectName` pattern (`navbar.tsx:169`). Each tick:
   `updateProject(currentProjectId, …)` locally **and** `POST /api/vapp-projects`.
   → **one hook covers** manual edits, **AI‑Edit‑panel** edits, and Style/Look changes (all mutate the same store).
3. **Stable `project_id`** — mint once per project (persist in the SavedProject + localStorage);
   send it on every autosave so versions accumulate under one id.
4. **Version dropdown (revert UI)** — in the navbar project menu (`navbar.tsx:413`), when a project
   is open, list `GET …/versions`; selecting one calls the existing `handleLoadProject` →
   `DESIGN_LOAD`. No new restore code.
5. *(Optional)* **auto‑open last project** on cold start (`editor.tsx:37` builds an empty
   StateManager today) — off by default.

## 8. Render → auto‑persist a project

- **Single choke point:** `POST /vapp/render/enqueue` (`vapp_server.py:8237`) already receives the
  full `design` + `user_id`. Have it also `POST /vapp/projects` (a version, `source:"render"`) and
  stamp the render `job_id` with `project_id` (and the version row with `render_job_id`).
  → "**any** render → project auto‑saved + linked" for the editor's default **queue** path.
- Local/remote render routes (`api/render/route.ts:87`, `api/render-remotion/route.ts:209`) can pass
  `project_id` through so their design also lands as a version (optional; queue path covers the default).

## 9. MCP / Dify / vidrush

- Point all programmatic emitters at the **same** `POST /vapp/projects` with the identical
  `{ project_id, name, data:<design> }` envelope. Their design already matches `DESIGN_LOAD`
  (`vapp_server_mcp.py:1693`, `_normalize_design:1049`), so **opening restores the full timeline
  with zero editor change**. Replace the current `editor_projects/<name>.json` overwrite‑write
  (`vapp_server_mcp.py:1828/1907`) with a version upsert. (vidrush = `vapp_server/vidrush/orch.py`.)

## 10. Revert / resume — two orthogonal layers (keep both)

| Layer | What | Scope | Persisted? |
|---|---|---|---|
| **Per‑message snapshot** (existing) | `operations.ts captureSnapshot/revertSnapshot` | one AI‑edit message's touched items | in‑session only |
| **Project versions** (this plan) | load an older `vapp_projects` version via `DESIGN_LOAD` | whole timeline, across reloads/devices/tools | yes (server) |

The snapshot stays as **fast in‑session undo**; project versions give **durable revert/resume‑from‑anywhere**.
Do **not** conflate them.

---

## 11. Rollout (phased, each shippable)

- **P1 — minimal high‑ROI slice:** `POST /vapp/projects` (versioned PB) + editor `POST` write‑through
  + autosave hook. → *every edit auto‑saved, reopen restores, version history exists.*
- **P2 — render:** hook `/vapp/render/enqueue` → version + job↔project link.
- **P3 — MCP/Dify/vidrush:** write the same envelope; drop the overwrite‑file behavior.
- **P4 — version UI:** navbar version dropdown → revert/resume; optional auto‑open‑last.

## 12. Open decisions (need your call)

1. **Store:** PocketBase `vapp_projects` collection (recommended) **vs** keep files but add
   `editor_projects/<project_id>/<version>.json`.
2. **Autosave cadence:** debounce interval (e.g. 2–5 s idle) + only when the design actually changed (hash/dirty flag).
3. **Version retention:** keep all vs last N + named/render versions.
4. **Multi‑device conflict:** last‑write‑wins per `project_id` (fine for solo) vs version‑branch on conflict.
5. **Identity for existing localStorage projects:** migrate/mint `project_id` on first autosave.

## 13. File touch‑list (when built)

**Editor:** `src/app/api/vapp-projects/route.ts` (add POST) · `src/features/editor/navbar.tsx`
(`handleSaveProject:190`, `handleLoadProject:236`, `buildProjectData:268`, autosave near `:169`,
version dropdown `:413`) · `src/features/editor/utils/project-storage.ts` (project_id) ·
`src/app/api/render/route.ts` + `render-remotion/route.ts` (pass project_id).
**vApp:** `vapp_server_mcp.py` (`/vapp/projects:859`, `render_project:1828`, `_render_design:1907`,
`_normalize_design:1049`) · `vapp_server.py:8237` (`/vapp/render/enqueue` → upsert version) · new PB `vapp_projects` collection.

---
*Restore path is already proven (`DESIGN_LOAD`); this plan only adds a shared, versioned store and
auto‑writes to it — nothing about the timeline JSON shape changes.*
