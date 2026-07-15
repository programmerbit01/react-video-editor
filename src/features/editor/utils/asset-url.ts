// ─────────────────────────────────────────────────────────────────────────────
// asset-url — the SINGLE source of truth for resolving a stored asset URL to what
// the browser actually fetches (timeline filmstrip, player, grid, and the Remotion
// render, which reads the design's src directly).
//
// DIRECT by default. R2 (rpublic.tomtap.ai) serves CORS `*`, so every consumer —
// including headless-Chrome render workers doing fetch()+Range — loads straight
// from R2 in parallel. That's fast. A same-origin /api/proxy hop only serializes
// everything through one Next process = slow; we do NOT use it.
//
// The proxy is legacy: it existed solely for the old Garage host that lacked a CORS
// preflight. It's OFF by default. If you still have old projects pointing at that
// host and cannot add CORS to the bucket, set NEXT_PUBLIC_LEGACY_GARAGE_PROXY=1 to
// route ONLY that host through /api/proxy. New uploads are always R2 → never need it.
// ─────────────────────────────────────────────────────────────────────────────

const LEGACY_GARAGE_HOSTS = ["vapp-media-gar.tomtap.ai"];
const LEGACY_PROXY_ON = process.env.NEXT_PUBLIC_LEGACY_GARAGE_PROXY === "1";

const editorBase = () =>
  (typeof window !== "undefined" && window.location.pathname.startsWith("/editor")) ? "/editor" : "";

// Resolve any stored src → the URL to fetch. Unwraps legacy /api/proxy wrappers
// baked into old/imported designs, keeps same-origin paths, returns DIRECT for
// everything else. Only the legacy Garage host is proxied, and only when opted in.
export function resolveAssetUrl(src: unknown): string {
  let raw = String(src || "");
  if (!raw) return "";

  // Unwrap a legacy proxy wrapper → the real URL (fixes proxy-baked imports).
  const m = raw.match(/\/api\/proxy\?url=(.+)$/);
  if (m) { try { raw = decodeURIComponent(m[1]); } catch {} }

  // Same-origin (e.g. /editor/uploads/…) — leave as-is.
  if (raw.startsWith("/")) return raw;

  // Opt-in legacy fallback: proxy ONLY the CORS-less Garage host.
  if (LEGACY_PROXY_ON) {
    try {
      if (LEGACY_GARAGE_HOSTS.includes(new URL(raw).hostname)) {
        return `${editorBase()}/api/proxy?url=${encodeURIComponent(raw)}`;
      }
    } catch { /* not absolute → fall through to direct */ }
  }

  return raw; // DIRECT
}
