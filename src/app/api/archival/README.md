# Archival / multi-source media search

`GET /api/archival` searches several stock + archival platforms at once and
returns one merged, normalized list. Every result carries its **source,
license and attribution** so it can be credited (important for documentaries).

Used by:
- **Editor GUI** — Stock tab → _Archival_ (`src/features/editor/menu-item/archival.tsx`)
- **MCP** — `search_archival` tool in `vapp_server/vapp_server_mcp.py`

Both call this same route, so any source you add here shows up in both places.

---

## Request

```
GET /api/archival?query=<text>&type=image|video&sources=<csv>&per_page=<n>&min_resolution=<px>
```

| param            | default            | notes                                        |
|------------------|--------------------|----------------------------------------------|
| `query`          | —                  | required search text                         |
| `type`           | `image`            | `image` or `video`                           |
| `sources`        | `pexels,openverse` | csv of source ids (see table below)          |
| `per_page`       | `20` (max 40)      | results **per source**                       |
| `min_resolution` | `0`                | skip items below this width OR height (0=off) |

## Response

```jsonc
{
  "items": [
    {
      "id": "pexels_i_123",
      "type": "image",
      "details": { "src": "...", "width": 1920, "height": 1080, "duration": 0 },
      "preview": "...",            // thumbnail (always loads in the grid)
      "source_name": "Pexels",
      "source_url": "...",          // where it came from (for the manifest)
      "license": "Pexels License (free)",
      "author": "Jane Doe",
      "title": "..."
    }
  ],
  "by_source": {                    // independence report — which platforms worked
    "pexels":   { "count": 12, "ok": true },
    "openverse":{ "count": 9,  "ok": true },
    "wikimedia":{ "count": 0,  "ok": false, "error": "..." }
  }
}
```

A source that times out / is blocked never breaks the search — it just reports
`ok: false` in `by_source` (the GUI shows `(x)` next to that checkbox).

---

## Current sources

| id          | platform           | media        | key? | notes                                  |
|-------------|--------------------|--------------|------|----------------------------------------|
| `pexels`    | Pexels             | image, video | yes  | key in route (env `PEXELS_API_KEY`)    |
| `openverse` | Openverse          | image        | no   | CC aggregator (Flickr Commons, museums)|
| `wikimedia` | Wikimedia Commons  | image        | no   | may be network-blocked in some regions |
| `archive`   | Internet Archive   | image        | no   | `services/img/<id>` representative image |

---

## Add a new data source

Everything lives in `route.ts`. Three small steps:

**1. Write an adapter** — an async fn that returns `NormItem[]`:

```ts
async function fromMySource(q: string, type: MediaType, n: number): Promise<NormItem[]> {
  if (type !== "image") return [];               // declare what you support
  const r = await fetch(`https://api.example.com/search?q=${encodeURIComponent(q)}&n=${n}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: timeoutSignal(),                      // 12s timeout, shared helper
  });
  if (!r.ok) throw new Error(`mysource ${r.status}`); // throw → reported as ok:false
  const d = await r.json();
  return (d.results || []).map((x: any) => ({
    id: `mysource_${x.id}`,
    type: "image",
    details: { src: x.full_url, width: Number(x.w || 0), height: Number(x.h || 0) },
    preview: x.thumb || x.full_url,
    source_name: "My Source",
    source_url: x.page_url || "",
    license: x.license || "see source",
    author: x.author || "Unknown",
    title: String(x.title || "").slice(0, 200),
  }));
}
```

**2. Register it** in the `ADAPTERS` map:

```ts
const ADAPTERS = { pexels: fromPexels, openverse: fromOpenverse,
                   wikimedia: fromWikimedia, archive: fromArchive,
                   mysource: fromMySource };   // ← add
```

**3. Add the checkbox** in `src/features/editor/menu-item/archival.tsx` `SOURCES`:

```ts
{ id: "mysource", label: "My Source", video: false },
```

That's it. The MCP `search_archival` tool already accepts any source id via its
`sources` csv param — no MCP change needed unless you want a new default.

### Guidelines
- Keep `details.src` a **directly fetchable** URL (the headless renderer must load
  it). If a source's files sit on a blocked CDN, the preview may still show but the
  final render can be black — prefer sources whose image files are reachable.
- Always fill `license` + `author` + `source_url` — they are saved to the item's
  `metadata` and used for the credits / source manifest.
- Throw on failure; never let one source reject the whole `Promise.all`.

---

## How the MCP side works

`search_archival(query, sources, media_type, count)` in `vapp_server_mcp.py` just
forwards to this route (`EDITOR_BASE/api/archival`) and returns `items` +
`by_source`. The AI uses `source_url` / `license` / `author` for its media
manifest and sets `details.kenBurns` on stills when assembling the timeline.
