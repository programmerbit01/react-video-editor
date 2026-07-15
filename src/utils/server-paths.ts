import path from "path";

// Absolute base = the project root, resolved at RUNTIME through an indirection the bundler
// CANNOT statically fold. Turbopack/webpack trace fs paths built from a *resolvable* base
// (process.cwd() + string literals) and then try to bundle every file under the matched
// directory — that's the "file pattern matches N files … over-bundling" build warning.
// Keeping the base opaque means the tracer can't resolve the directory, so it matches
// nothing and stays silent. These paths are read at REQUEST time (rendered mp4s, uploaded
// assets, export scratch) — never at build time — so there is genuinely nothing to bundle.
// eslint-disable-next-line no-eval
const PROJECT_ROOT: string = eval("process.cwd()");

export function publicPath(...segments: string[]): string {
  return path.join(PROJECT_ROOT, "public", ...segments);
}
