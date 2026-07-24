// ─────────────────────────────────────────────────────────────────────────────
// One-time cache purge when the deployed build changes.
//
// WHY THIS EXISTS. Several stores persist to localStorage, and localStorage is
// per-browser and survives BOTH a refresh and a hard refresh. So when a deploy
// changes the shape of anything cached there, the app rehydrates the old shape
// and misbehaves — and the user cannot fix it by reloading. Switching to another
// browser "fixes" it only because that browser has an empty localStorage. That is
// exactly the reported symptom: reload doesn't help, changing browser does.
//
// The existing defence is a hand-maintained `version:` on each zustand persist
// store. Only `upload-store` actually has one (bumped to 4 by hand after cached
// items collided on their React key). `vapp-ai-edit`, `vapp-caption-transcripts`
// and `vapp-global-animation` have no version at all, and the raw localStorage
// keys have none either — so any shape change in those is silent and permanent
// until the user finds another browser.
//
// This makes it automatic: stamp each build, and when the stamp changes, drop the
// caches once. It removes the need to remember a version bump.
//
// WHAT IT DROPS: only state that is DERIVED and refetchable — the media library
// cache, the video poster cache, and cached transcripts. All three come straight
// back from the server / a re-capture on next use.
//
// WHAT IT NEVER TOUCHES: anything the user would actually lose — saved projects,
// the remote-render url, panel preferences, theme, tokens. If you add a new key,
// default to leaving it alone; only add it below if losing it costs the user
// nothing.
//
// Must run BEFORE any zustand persist store is created, because those hydrate at
// module-import time. It is called from an inline head script (see layout.tsx),
// which the browser executes before the app bundle.
// ─────────────────────────────────────────────────────────────────────────────

/** Derived caches — safe to drop, the server or a re-capture rebuilds them. */
export const PURGE_ON_NEW_BUILD = [
  "upload-store",              // vApp media library cache (refetched on next open)
  "vapp_video_posters_v1",     // captured video thumbnails (re-captured lazily)
  "vapp-caption-transcripts",  // STT results (refetched via sttForUrl)
];

/** User data + preferences — never dropped. Listed so the intent is explicit. */
export const NEVER_PURGE = [
  "vapp_saved_projects",       // the user's projects
  "vapp_render_remote_url",    // their render target
  "vapp-ai-edit",              // panel prefs (position, size, model)
  "vapp-global-animation",     // animation prefs
  "vapp_videos_expanded",      // panel prefs
];

export const BUILD_STAMP_KEY = "vapp_build_stamp";

/**
 * The inline script, as a string. Kept as source text (not a bundled import) so
 * it can run in <head> ahead of the app bundle. Deliberately tiny and total: any
 * failure is swallowed, because a broken cache purge must never stop the editor
 * from loading.
 */
export function buildStampScript(stamp: string): string {
  const keys = JSON.stringify(PURGE_ON_NEW_BUILD);
  return `(function(){try{
var s=${JSON.stringify(String(stamp || ""))};if(!s)return;
var k=${JSON.stringify(BUILD_STAMP_KEY)};var prev=localStorage.getItem(k);
if(prev===s)return;
localStorage.setItem(k,s);
if(prev===null)return;   /* first ever visit: nothing stale to drop */
${keys}.forEach(function(n){try{localStorage.removeItem(n)}catch(e){}});
console.info('[build] new build '+prev+' -> '+s+', dropped stale caches');
}catch(e){}})();`;
}
