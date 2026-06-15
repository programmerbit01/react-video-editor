const STORAGE_KEY = "vapp_saved_projects";

export interface SavedProject {
  id: string;
  name: string;
  savedAt: number;
  data: Record<string, unknown>;
}

export function getSavedProjects(): SavedProject[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as SavedProject[];
  } catch {
    return [];
  }
}

export function saveProject(name: string, data: Record<string, unknown>): SavedProject {
  const projects = getSavedProjects();
  const project: SavedProject = {
    id: `project_${Date.now()}`,
    name,
    savedAt: Date.now(),
    data,
  };
  const updated = [project, ...projects];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  return project;
}

export function updateProject(id: string, name: string, data: Record<string, unknown>): SavedProject {
  const projects = getSavedProjects();
  const updated = projects.map((p) =>
    p.id === id ? { ...p, name, data, savedAt: Date.now() } : p
  );
  // Move updated project to top
  const idx = updated.findIndex((p) => p.id === id);
  if (idx > 0) {
    const [proj] = updated.splice(idx, 1);
    updated.unshift(proj);
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  return updated[0];
}

export function deleteProject(id: string): void {
  const projects = getSavedProjects().filter((p) => p.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
}
