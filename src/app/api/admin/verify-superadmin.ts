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

export async function verifySuperadmin(baseUrl: string, token: string): Promise<SuperadminResult> {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
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
    // superadmin is never wrongly locked out.
    const role = String(
      d?.user?.role || d?.role || d?.data?.user?.role || d?.profile?.role || "",
    ).toLowerCase();
    if (role !== "superadmin") return { ok: false, status: 403, role, error: "superadmin only" };
    return { ok: true, status: 200, role };
  } catch (e: any) {
    return { ok: false, status: 502, error: String(e?.message || e) };
  }
}
