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
// ── CORS ─────────────────────────────────────────────────────────────────────
// The R2 bucket serves `access-control-allow-origin: *`. Verified against the live
// bucket, on a real object, with a cache-busting query so it is the policy talking
// and not an old cached response.
//
// It used to be a per-origin allowlist, and that is worth knowing about because it
// failed in a way nobody could read:
//
//   • An origin is an exact string. `http://192.168.50.204` and
//     `http://192.168.50.204:3000` are two different origins — the list had the
//     first, the editor runs on the second, and media died with no clue why.
//   • R2 does NOT accept partial wildcards. `http://192.168.50.204:*` is rejected
//     outright ("An error occurred while updating the CORS Policy") — the docs allow
//     only `scheme://host[:port]`. So an allowlist means every box × every port, by
//     hand, forever, and one missing entry is a silent failure.
//   • With a per-origin ACAO, Cloudflare caches the response per origin. We measured
//     a HIT carrying an `age: 184444` header — a two-day-old ACAO for an origin that
//     had since been removed from the policy. So the bucket "worked" from one box and
//     not another purely on cache state, and any test that forgets to bust the cache
//     reads the past. That cost us two wrong diagnoses.
//
// `*` removes all of that: one constant header, valid for every origin, cacheable
// once. It gives nothing away — the bucket is public-read, so anything CORS would
// have blocked in a browser was already one `curl` away. It does not grant PUT
// either; that needs a presigned URL, which is the actual key.
//
// The one thing `*` forbids is credentialed requests (`credentials: "include"`) —
// browsers reject `*` there. Nothing here sends credentials to R2; if you add that,
// this breaks and no allowlist entry will save you.
//
// CORS is a BROWSER rule. The FF export's downloads, ffmpeg and ffprobe never see
// it. It lands on fetch(), on canvas reads (the timeline filmstrip), and on
// Remotion's headless Chrome at 127.0.0.1:3001.
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
