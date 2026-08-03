// Projects persist server-side now — in PocketBase (vapp_jobs, type="project"),
// scoped to the signed-in user — instead of browser localStorage, which hit the
// ~5MB QuotaExceededError once a few projects piled up (and never synced across
// devices/browsers). Media stays on R2; only the reference JSON travels here.
//
// The editor talks to its OWN /api/vapp-projects route, which forwards the vApp
// token (passed to the embedded editor as ?token=…) so the server knows whose
// projects to read/write. All calls are async now.

export interface SavedProject {
  id: string;
  name: string;
  savedAt: number;
  data: Record<string, unknown>;
}

function editorApi(path: string): string {
  if (typeof window !== "undefined" && window.location.pathname.startsWith("/editor")) {
    return `/editor${path}`;
  }
  return path;
}

// The vApp auth token (and optional baseUrl) ride in the editor URL. The save/load
// route needs the token to resolve WHICH user's projects to touch — no cross-user mix.
function authParams(extra?: Record<string, string>): string {
  const q = new URLSearchParams();
  if (typeof window !== "undefined") {
    const p = new URLSearchParams(window.location.search);
    const token = p.get("token") || "";
    const baseUrl = p.get("baseUrl") || "";
    if (token) q.set("token", token);
    if (baseUrl) q.set("baseUrl", baseUrl);
  }
  for (const [k, v] of Object.entries(extra || {})) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
}

export async function getSavedProjects(): Promise<SavedProject[]> {
  try {
    const res = await fetch(editorApi(`/api/vapp-projects${authParams()}`), { cache: "no-store" });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.projects) ? (data.projects as SavedProject[]) : [];
  } catch {
    return [];
  }
}

async function persist(project: {
  id?: string;
  name: string;
  data: Record<string, unknown>;
}): Promise<SavedProject> {
  const res = await fetch(editorApi(`/api/vapp-projects${authParams()}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(project),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(String(j?.error || j?.detail || `save failed (${res.status})`));
  }
  const data = await res.json();
  const p = (data?.project ?? {}) as Partial<SavedProject>;
  return {
    id: String(p.id || project.id || ""),
    name: String(p.name || project.name || ""),
    savedAt: Number(p.savedAt || Date.now()),
    data: project.data,
  };
}

export async function saveProject(name: string, data: Record<string, unknown>): Promise<SavedProject> {
  return persist({ name, data });
}

export async function updateProject(
  id: string,
  name: string,
  data: Record<string, unknown>
): Promise<SavedProject> {
  return persist({ id, name, data });
}

export async function deleteProject(id: string): Promise<void> {
  try {
    await fetch(editorApi(`/api/vapp-projects${authParams({ id })}`), { method: "DELETE" });
  } catch {}
}
