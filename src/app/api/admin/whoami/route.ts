// Is the caller a superadmin? Client-side button visibility asks this. It goes through the
// editor's own route (not a direct vApp call) so it works regardless of how the editor was
// launched — `baseUrl`, `vappHost`, or neither — because the base is resolved server-side.
//
//   GET /api/admin/whoami?token=<vApp token>[&baseUrl=<vApp base>]  →  { superadmin: boolean }

import { NextResponse } from "next/server";
import { verifySuperadmin } from "../verify-superadmin";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token") || "";
  const baseUrl = searchParams.get("baseUrl") || "";
  if (!token) return NextResponse.json({ superadmin: false });
  const gate = await verifySuperadmin(baseUrl, token);
  return NextResponse.json({ superadmin: gate.ok, role: gate.role });
}
