import path from "path";

// Build absolute paths under the project's public/ dir for RUNTIME fs access — rendered
// mp4s, uploaded assets, export scratch. The "public" segment is resolved at runtime (env
// override, else assembled from a non-literal) and this lives in its own module, so
// Turbopack/webpack cannot statically fold `path.join(cwd, "public", <dynamic>)` and end up
// tracing the whole public/ tree (10k+ files) into the server bundle. That static trace is
// what raises the "file pattern matches N files … over-bundling" warnings; these files only
// ever exist at request time, never at build time, so there is nothing to bundle.
const PUBLIC_DIRNAME =
  process.env.EDITOR_PUBLIC_DIRNAME || Buffer.from("cHVibGlj", "base64").toString(); // "public"

export function publicPath(...segments: string[]): string {
  return path.join(process.cwd(), PUBLIC_DIRNAME, ...segments);
}
