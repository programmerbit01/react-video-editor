# Web / News Search — media tab

A new **independent** media tab ("Web", next to Stock) for pulling live web / news / image
**material** onto the timeline — the visual‑source layer for AI‑news / tech‑channel videos.

## What it is
A standalone panel (`menu-item/web-search.tsx`): type a query, pick **News / Web / Images**
(+ recency for News), get a result grid you **click or drag onto the timeline** (same
`Draggable` path as Stock). Fully independent — it imports nothing from `archival`, so a
broken web search only ever breaks this tab.

## Backend — SearXNG (free, self‑hosted, no key)
`GET /api/websearch` (`src/app/api/websearch/route.ts`) calls a self‑hosted **SearXNG**
instance's JSON API directly. SearXNG needs **no API key** (just an instance URL), aggregates
70+ engines, and returns web/images/news with time filtering — so there are no provider creds
to hide and no reason to route through the vApp/Dify lane.

```
editor → GET /api/websearch?query=&type=news|web|images&recency=  →  SearXNG /search?format=json  →  normalized grid
```

- `type` → SearXNG `categories` (news / general / images); `recency` → `time_range` (day/week/month/year).
- Narrow to a source by typing `site:openai.com` (or a domain / paper title) right in the
  query — the engine stays generic, the user drives the filter. Nothing about *which sources*
  is hardcoded.
- Result mapping: `img_src`/`thumbnail_src` → image; `resolution` "1200×675" → w/h; `url` →
  source page; `content` → snippet; text‑only hits fall back to the site favicon. Real images
  sort first for a nicer grid.

## Setup
- Run a SearXNG container; **enable JSON output** (`search.formats: [html, json]`) and set
  `server.limiter: false` (else it 403s the API).
- Point the route at it: env `SEARXNG_BASE` (default `http://192.168.50.123:8080`).

## Registration (where the tab is wired)
- `interfaces/layout.ts` — `"web"` menu id.
- `menu-list.tsx` + `menu-list-horizontal.tsx` — the **Web** tab (Globe icon).
- `menu-item.tsx` — `activeMenuItem === "web"` → `<WebSearch />`.

## Status
Phase 1 (tab + SearXNG fetch + grid). The editor dev server must be **restarted** to register
the new tab + route (new files aren't hot‑picked on the external volume).

**Next:** an optional "✨ rank by relevance" vision pass over results, and wiring this as a
visual **source** into the faceless matcher (news topic → transcribe → place web material at
segment times) for a full AI‑news video pipeline.
