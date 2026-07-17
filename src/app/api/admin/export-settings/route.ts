// Deployment-level export settings the superadmin controls from the editor navbar.
//
//   GET  → the current effective settings. Public: it is one number the render routes and
//          the settings panel both read; nothing secret. No token needed.
//   PUT  → change the RAM budget. Superadmin ONLY, verified against the vApp (the UI hiding
//          the button is not a gate). Body: { ramBudgetGB, baseUrl, token }.
//
// No proxy: PUT verifies by fetching the vApp directly with the caller's own baseUrl+token.

import { NextResponse } from "next/server";
import {
  readExportSettings,
  writeExportSettings,
  clampRamBudget,
  RAM_BUDGET_MIN,
  RAM_BUDGET_MAX,
  RAM_BUDGET_DEFAULT,
} from "../export-settings-store";
import { verifySuperadmin } from "../verify-superadmin";

export async function GET() {
  const s = await readExportSettings();
  // The machine's core count so the UI hint can tell the truth: ffmpeg parallelism is capped by
  // cores-1 as well as the RAM budget, whichever is smaller.
  const os = await import("os");
  const cores = os.cpus()?.length || 0;
  return NextResponse.json({
    settings: s,
    cores,
    bounds: { min: RAM_BUDGET_MIN, max: RAM_BUDGET_MAX, default: RAM_BUDGET_DEFAULT },
  });
}

export async function PUT(request: Request) {
  let body: any = {};
  try { body = await request.json(); } catch { /* empty body → validation fails below */ }

  const budget = clampRamBudget(body?.ramBudgetGB);
  if (budget == null) {
    return NextResponse.json(
      { message: `ramBudgetGB must be a number between ${RAM_BUDGET_MIN} and ${RAM_BUDGET_MAX}` },
      { status: 400 },
    );
  }

  const gate = await verifySuperadmin(String(body?.baseUrl || ""), String(body?.token || ""));
  if (!gate.ok) {
    return NextResponse.json({ message: gate.error || "forbidden" }, { status: gate.status });
  }

  const saved = await writeExportSettings({ ramBudgetGB: budget, updatedBy: gate.role });
  return NextResponse.json({ settings: saved });
}
