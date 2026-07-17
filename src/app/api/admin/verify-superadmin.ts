// Server-side superadmin gate for the editor's admin routes. A UI that only HIDES the
// button is not a gate — a normal user or a plain curl could still PUT the setting. So the
// write path asks the vApp who the token belongs to and allows only role=superadmin.
//
// This mirrors vapp_higgs/lib/server-vapp.js::verifySuperadmin, deliberately: same vApp
// endpoint, same accepted response shapes. It fetches the vApp DIRECTLY (no proxy) — the
// caller passes the baseUrl + token the editor already holds.

export interface SuperadminResult {
  ok: boolean;
  status: number;
  role?: string;
  error?: string;
}

// The vApp base to verify against. The editor is launched with different param schemes
// (`baseUrl` on some deployments, `vappHost` on others, neither on same-origin setups), so
// the client can't be relied on to supply it. Fall back to the same server-side vApp base the
// render route uses — the token is what actually authenticates, and it's always in the URL.
function resolveVappBase(passed?: string): string {
  const p = String(passed || "").trim().replace(/\/+$/, "");
  if (p) return p;
  return (process.env.VAPP_SERVER_BASE || "http://127.0.0.1:8091").replace(/\/+$/, "");
}

export async function verifySuperadmin(baseUrl: string, token: string): Promise<SuperadminResult> {
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
    if (!res.ok) return { ok: false, status: 403, error: "auth rejected" };
    const d = await res.json().catch(() => ({} as any));
    // /vapp/auth/me returns { user: { role }, token }; accept a few shapes so a real
    // admin is never wrongly locked out.
    const role = String(
      d?.user?.role || d?.role || d?.data?.user?.role || d?.profile?.role || "",
    ).toLowerCase();
    // The vApp's role vocabulary is superadmin | admin | user, and a PocketBase superuser login
    // (how the owner usually signs in) resolves to role "admin", NOT "superadmin". The vApp gates
    // its own privileged actions on `role in (admin, superadmin)`, so match that — a superadmin-only
    // gate would hide this from the very person who set the deployment up.
    if (role !== "superadmin" && role !== "admin") {
      return { ok: false, status: 403, role, error: "admin only" };
    }
    return { ok: true, status: 200, role };
  } catch (e: any) {
    return { ok: false, status: 502, error: String(e?.message || e) };
  }
}
