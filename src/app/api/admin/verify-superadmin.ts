// Server-side identity + admin gate for the editor's admin routes. A UI that only HIDES a
// control is not a gate — a normal user or a plain curl could still PUT the setting. So the
// write path asks the vApp who the token belongs to and allows only role admin/superadmin.
//
// It fetches the vApp DIRECTLY (no proxy). The base is resolved server-side because the editor
// is launched with different param schemes (`baseUrl`, `vappHost`, or neither) — the token,
// always in the URL, is what actually authenticates.

export interface VappUser {
  name: string;
  email: string;
  role: string;
}

export interface WhoamiResult {
  ok: boolean; // reached the vApp and got a user
  status: number;
  user?: VappUser;
  allowed?: boolean; // role is admin or superadmin
  error?: string;
}

// vApp privileged actions gate on `role in (admin, superadmin)`. A PocketBase superuser login
// (how the owner usually signs in) resolves to role "admin", NOT "superadmin", so match both.
const ADMIN_ROLES = new Set(["admin", "superadmin"]);

function resolveVappBase(passed?: string): string {
  const p = String(passed || "").trim().replace(/\/+$/, "");
  if (p) return p;
  return (process.env.VAPP_SERVER_BASE || "http://127.0.0.1:8091").replace(/\/+$/, "");
}

/** Who is this token? Returns the vApp user + whether they may edit admin settings. */
export async function fetchVappUser(baseUrl: string, token: string): Promise<WhoamiResult> {
  const base = resolveVappBase(baseUrl);
  const tok = String(token || "").replace(/^Bearer\s+/i, "").trim();
  if (!tok) return { ok: false, status: 401, error: "missing token" };
  if (!base) return { ok: false, status: 502, error: "no vApp base" };
  try {
    let signal: AbortSignal | undefined;
    try { signal = AbortSignal.timeout(8000); } catch { /* older runtime */ }
    const res = await fetch(`${base}/vapp/auth/me`, {
      headers: { Authorization: `Bearer ${tok}` },
      cache: "no-store",
      signal,
    });
    if (!res.ok) return { ok: false, status: res.status, error: "auth rejected" };
    const d = await res.json().catch(() => ({} as any));
    const u = d?.user || d?.data?.user || d?.profile || d || {};
    const role = String(u?.role || d?.role || "").toLowerCase();
    const user: VappUser = {
      name: String(u?.name || u?.username || (u?.email ? String(u.email).split("@")[0] : "") || "User"),
      email: String(u?.email || ""),
      role,
    };
    return { ok: true, status: 200, user, allowed: ADMIN_ROLES.has(role) };
  } catch (e: any) {
    return { ok: false, status: 502, error: String(e?.message || e) };
  }
}

/** PUT gate: true only when the token belongs to an admin/superadmin. */
export async function verifySuperadmin(
  baseUrl: string,
  token: string,
): Promise<{ ok: boolean; status: number; role?: string; error?: string }> {
  const r = await fetchVappUser(baseUrl, token);
  if (!r.ok) return { ok: false, status: r.status, error: r.error };
  if (!r.allowed) return { ok: false, status: 403, role: r.user?.role, error: "admin only" };
  return { ok: true, status: 200, role: r.user?.role };
}
