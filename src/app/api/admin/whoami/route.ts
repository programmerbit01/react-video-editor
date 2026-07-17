// Who is the caller? The navbar user menu asks this to show the signed-in name + role, and to
// decide whether to offer admin controls (Export settings). Goes through the editor's own route
// so it works regardless of how the editor was launched — the base is resolved server-side.
//
//   GET /api/admin/whoami?token=<vApp token>[&baseUrl=<vApp base>]
//     → { ok, user: { name, email, role }, allowed }   (allowed = admin/superadmin)

import { NextResponse } from "next/server";
import { fetchVappUser } from "../verify-superadmin";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token") || "";
  const baseUrl = searchParams.get("baseUrl") || "";
  if (!token) return NextResponse.json({ ok: false, allowed: false, error: "no token" });
  const r = await fetchVappUser(baseUrl, token);
  return NextResponse.json({
    ok: r.ok,
    user: r.user,
    role: r.user?.role,
    allowed: !!r.allowed,
    superadmin: !!r.allowed, // back-compat with the older button
    error: r.error,
  });
}
