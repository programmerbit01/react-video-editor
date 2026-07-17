// ─────────────────────────────────────────────────────────────────────────────
// asset-url — the SINGLE place a stored asset URL becomes the URL that gets fetched
// (timeline filmstrip, player, grid, and the Remotion render, which reads the
// design's src directly).
//
// DIRECT. There is no proxy any more.
//
// There used to be a /api/proxy hop, kept "for the old Garage host that lacked a
// CORS preflight". Checked against the live host: it answers
// `access-control-allow-origin: *`. The one reason the proxy existed was not true —
// and it was off by default anyway, so nothing had gone through it in a long time.
// Deleted.
//
// This function still UNWRAPS `/api/proxy?url=…`, because old designs have that
// baked into their src. That is a migration, not a proxy: it hands back the real
// URL. normalizeProject (project-schema.ts) runs it on load and reports the repair;
// autosave then persists the clean shape.
//
// ── CORS, accurately ─────────────────────────────────────────────────────────
// R2 does NOT serve `*`. It serves an ALLOWLIST. Verified against the live bucket
// with a real object:
//
//   https://vh.tomtap.ai         → 206 + access-control-allow-origin  ✓
//   http://192.168.50.216:3000   → 206 + access-control-allow-origin  ✓
//   http://192.168.50.204:3000   → 206, NO access-control-allow-origin ✗
//   http://localhost:3001        → 206, NO access-control-allow-origin ✗
//
// The bytes come back either way — the FF export's downloads, ffmpeg and ffprobe
// are server-side and CORS never applies to them. What it does hit is the browser:
// fetch(), canvas reads (the timeline filmstrip), and Remotion's headless Chrome.
// An origin missing from that allowlist sees media fail in ways that look like
// anything except a CORS policy.
//
// Add an editor origin → add it to the R2 bucket's CORS policy too.
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve a stored src → the URL that gets fetched. Direct, always. */
export function resolveAssetUrl(src: unknown): string {
  let raw = String(src || "");
  if (!raw) return "";

  // Old designs carry `/api/proxy?url=<real>` — hand back the real URL.
  const m = raw.match(/\/api\/proxy\?url=(.+)$/);
  if (m) {
    try {
      raw = decodeURIComponent(m[1]);
    } catch {
      /* malformed wrapper → fall through with what we have */
    }
  }

  return raw;
}
