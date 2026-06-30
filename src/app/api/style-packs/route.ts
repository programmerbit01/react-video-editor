import { NextResponse } from "next/server";

const VAPP_BASE = (process.env.VAPP_SERVER_BASE || "http://127.0.0.1:8091").replace(/\/+$/, "");

export async function GET() {
  try {
    const res = await fetch(`${VAPP_BASE}/vapp/style-packs`, { cache: "no-store" });
    if (!res.ok) return NextResponse.json({ packs: {} });
    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ packs: {} });
  }
}
