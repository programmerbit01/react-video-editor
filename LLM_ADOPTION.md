# AI Edit → `/vapp/llm` adoption (diff‑plan)

> **Status: ✅ IMPLEMENTED — 2026‑07‑12.** AI‑Edit's stateless **prompt → ops** call now routes through
> the vApp unified LLM service (`POST /vapp/llm?stream=1`, task `editor_edit`) instead of raw
> `/v1/chat/completions`, so model / thinking / retry / prompt policy lives in **one config row**.
> Additive / strangler — the raw path stays as fallback (`AI_EDIT_USE_VAPP_LLM=0`).

> **What shipped** — all in `src/app/api/ai-edit/route.ts`, **panel untouched**:
> - Default `POST /api/ai-edit` → `POST /vapp/llm?stream=1 task="editor_edit"`. The service's SSE
>   (`{type:"thinking"|"content",delta}` + `[DONE]`) is **translated** to the OpenAI‑shape SSE
>   (`choices[].delta.reasoning_content` / `.content`) the panel's `runChat` already parses →
>   **live typing + 💭 thinking panel both preserved** (backend added streaming to `/vapp/llm`).
> - `overrides.system = OPS_SYSTEM_PROMPT` (editor stays source of truth for ops); model id
>   `litellm/GO20 → GO20`; `reasoning_effort:"low" → thinking:"off"`. **0 change to `operations.ts`, 0 config.**
> - Escape hatch: `AI_EDIT_USE_VAPP_LLM=0` → raw `/v1/chat/completions` streaming path.
> - The earlier **streaming trade‑off (§4) is RESOLVED** — the backend added SSE, so nothing is lost.

---

## 1. The service contract (verified)

`llm(task, input_text, api_key="", overrides=None, user="vapp")` → returns:
```jsonc
// success
{ "ok": true,  "text": "...", "task": "...", "model_used": "GO20", "provider": "litellm", "latency_ms": 1234 }
// error → FAIL‑OPEN (returns the original input as text)
{ "ok": false, "text": "<original input_text>", "task": "...", "model_used": "", "provider": "...", "error": "...", "latency_ms": 0 }
```
- Config resolution: **`_default` → task row → `overrides`** (overrides win; `null` values dropped).
- HTTP: `POST /vapp/llm { task, input|prompt|query, overrides?, api_key? }` → `{ ok, text, ... }`
  (or bare text with `?format=text` / `Accept: text/plain`). `GET /vapp/llm/tasks` → the live menu.
- **NO streaming** (`stream:false` hardcoded). **NO JSON/structured mode** — returns **bare text**.
  `thinking:"off"` → `reasoning_effort:low` + `think:false` + strips `<think>…</think>`. Default timeout **120 s**.

## 2. Key insight (why adoption is cheap)

The **ops contract lives entirely in the editor**: `OPS_SYSTEM_PROMPT` (`operations.ts:434`) +
`extractOps()` (`operations.ts:471`, pulls the fenced ```json and `JSON.parse`s it). The service is
just *text in → text out*. So adoption = call `/vapp/llm` with the ops prompt as `overrides.system`,
take `.text`, hand it to the **same** `extractOps`. **Zero change to `operations.ts`.** No JSON‑mode
needed (the editor already parses text). No config edit needed (Option A).

## 3. Change‑list (exact)

### 3a. `src/app/api/ai-edit/route.ts` — POST (only real change)
Add a branch selected by a flag (`body.route === "unified"` **or** env `AI_EDIT_USE_VAPP_LLM=1`);
keep the existing `/v1/chat/completions` block untouched as the fallback.

```ts
// when unified:
const r = await fetch(`${VAPP_SERVER_BASE}/vapp/llm`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    task: "editor_edit",
    input: userContent,                      // projCtx + selectionCtx + request (USER role only)
    overrides: {
      system: OPS_SYSTEM_PROMPT,             // ops contract stays client‑side → pass it here
      model: mapModel(body.model),           // "litellm/GO20" → "GO20"  (dropdown → config id)
      thinking: body.reasoning_effort === "low" ? "off" : "on",
      temperature: 0.2,
      max_tokens: 1200,
    },
    api_key: token,
  }),
  // allow ≥120s (service blocks)
});
const j = await r.json();
return Response.json({ content: j.text ?? "", ok: j.ok, error: j.error });  // same shape panel already consumes (non‑stream branch)
```
- **Force non‑stream** on this branch (service can't stream) → return JSON `{ content }`.
- `mapModel`: strip the `litellm/` prefix so the dropdown id (`litellm/GO20`) matches the config model (`GO20`).
- GET handler (`/v1/models` for the dropdown) — **unchanged**.

### 3b. `src/features/editor/control-item/ai-edit-panel.tsx` — minimal
- In the `runPrompt` payload (`~:304`), when unified, set `stream:false` (or add `route:"unified"`).
  `runChat` (`:40`) already handles the non‑stream JSON branch (`:50`) and returns `{content}`.
- **`extractOps` path unchanged.** System+user split already matches (system→`overrides.system`, user→`input`).

### 3c. Config `editor_edit.system` — TWO options
- **Option A (recommended, zero‑risk):** leave the row's weak `system` as‑is; override it from
  route.ts via `overrides.system = OPS_SYSTEM_PROMPT`. Overrides win → editor stays the single
  source of truth for ops; adding an op needs **no** backend edit.
- **Option B (server‑owned prompt):** replace `editor_edit.system` in `model_config.json` with the
  strict ops‑JSON prompt. Downside: **two copies** to keep in sync (the timeline context still comes
  from the editor anyway). **Prefer A.**

## 4. Trade‑offs / blockers (decide before flipping AI‑Edit)

- **Loss of streaming** — `/vapp/llm` returns one blocking JSON. AI‑Edit's live typing + 💭 thinking
  panel (`ai-edit-panel.tsx:87/776`) goes away (`…` then result). **Functionally fine** — `extractOps`
  needs the full text anyway (`ai-edit-panel.tsx:325`) — but a visible UX downgrade. Keep streaming on the `/v1` fallback.
- **`reasoning_content` empty** — nothing to show in the thinking panel on the unified path.
- **Model dropdown** — service ignores per‑request model unless `overrides.model` is sent → forward it
  (with the `litellm/GO20 → GO20` mapping). GET `/v1/models` still powers the dropdown.
- **Thinking toggle** — map panel `reasoning_effort:"low"` → `overrides.thinking:"off"`; drop `extra_body.think`
  (service applies it internally).
- **Timeout** — route fetch must allow ≥120 s (no partial output on a slow model).
- **Net gain** — policy centralization (model/thinking/fallback in one row), *not* new capability. AI‑Edit
  already gets model+reasoning from `/v1`, and the ops prompt is client‑side. The only real cost is streaming.

## 5. Recommended rollout (strangler)

1. **Clean win first (no UX loss):** adopt `/vapp/llm` for the **non‑streaming, fire‑and‑forget text
   tasks** — prompt‑optimize, translate, `visual_query`, `optimize_image/video`. Pure config win.
2. **AI‑Edit behind a flag:** ship the unified branch flag‑guarded, **default = streaming `/v1`**.
   Flip to unified when you've tested it. You keep both without breaking anything.

## 6. Verify

- `curl $VAPP/vapp/llm/tasks` → `editor_edit` present.
- `curl -s $VAPP/vapp/llm -H 'Content-Type: application/json' -d '{"task":"editor_edit","input":"make the intro 3 seconds shorter","overrides":{"system":"<OPS_SYSTEM_PROMPT>"}}'`
  → returns valid **ops JSON** in `.text` (then `JSON.parse` succeeds).
- Editor: AI Edit panel prompt (unified flag on) → ops applied on the timeline; fail‑open → on parse
  failure, apply **nothing** (no crash).

## 7. Effort

- **Files: 2** (`ai-edit/route.ts` ~20‑line branch + `mapModel`; `ai-edit-panel.tsx` ~2 lines).
  **0** changes to `operations.ts`. **0** config changes if Option A.
- The deciding factor is **streaming UX**, not effort.

## 8. File touch‑list

`src/app/api/ai-edit/route.ts` (POST: add unified branch + `mapModel`) ·
`src/features/editor/control-item/ai-edit-panel.tsx` (`runPrompt` stream flag) ·
*(Option B only)* `vapp_server/configs/model_config.json → llm_tasks.editor_edit.system`.
Env: `AI_EDIT_USE_VAPP_LLM`. Reference: `vapp_server/vapp_llm/llm_service.py`, `LLM_SERVICE.md`.
