// Built-in AI-Edit director (planner system prompt) overrides, set by a superadmin in the editor.
//
//   GET → the current overrides map. Public: it is just the effective prompt text the editor
//         already sends as a system message; nothing secret. No token needed.
//   PUT → set or reset one built-in director's prompt. Superadmin ONLY, verified against the vApp
//         (`verify-superadmin`); the UI hiding the ✎ icon is not a gate. Applies globally + live.
//         Body: { id, systemPrompt, label?, remove?, baseUrl, token }.
//
// No proxy: PUT verifies by fetching the vApp directly with the caller's own baseUrl + token.

import { NextResponse } from "next/server";
import { readDirectors, writeDirectorOverride, isBuiltinDirectorId } from "../directors-store";
import { verifySuperadmin } from "../verify-superadmin";

export async function GET() {
  const s = await readDirectors();
  return NextResponse.json({ overrides: s.overrides, updatedAt: s.updatedAt, updatedBy: s.updatedBy });
}

export async function PUT(request: Request) {
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    /* empty body → validation fails below */
  }

  const id = String(body?.id ?? "");
  if (!isBuiltinDirectorId(id)) {
    return NextResponse.json({ message: "unknown built-in director id" }, { status: 400 });
  }
  const remove = !!body?.remove;
  const systemPrompt = String(body?.systemPrompt || "");
  if (!remove && systemPrompt.trim().length < 10) {
    return NextResponse.json({ message: "systemPrompt is required (min 10 chars)" }, { status: 400 });
  }

  const gate = await verifySuperadmin(String(body?.baseUrl || ""), String(body?.token || ""));
  if (!gate.ok) {
    return NextResponse.json({ message: gate.error || "forbidden" }, { status: gate.status });
  }

  const saved = await writeDirectorOverride(id, {
    systemPrompt,
    label: body?.label,
    remove,
    updatedBy: gate.role,
  });
  return NextResponse.json({ overrides: saved.overrides });
}
