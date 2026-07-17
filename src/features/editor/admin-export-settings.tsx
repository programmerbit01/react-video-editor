"use client";

// Superadmin-only export controls, shown in the navbar. The ONE knob is the RAM budget an
// export may use; the ffmpeg/worker parallelism derives from it (the render routes do the
// math and clamp to actually-free RAM). Deliberately not a pile of quality levers — those
// reintroduce the shaky-video / OOM tradeoffs. Saved server-side; applies to every export
// this machine runs (GUI, and any render that hits this machine's route).
//
// The button only renders for a superadmin: on mount we ask the vApp who the token belongs
// to (the same check the server PUT enforces — the UI gate alone is never the security).

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SlidersHorizontal, Check, Loader2 } from "lucide-react";
import { vappCtx } from "@/utils/vapp-api";

// Mirror of the FF route's per-segment RAM cost, for the "≈ N ffmpeg" hint only. The server
// is authoritative; this is just so the number the admin picks has a tangible meaning.
const PER_FFMPEG_GB = 0.95;
const EDITOR_BASE = process.env.NEXT_PUBLIC_BASE_PATH || "/editor";

export default function AdminExportSettings() {
  const [isSuperadmin, setIsSuperadmin] = useState(false);
  const [open, setOpen] = useState(false);
  const [budget, setBudget] = useState<number | "">("");
  const [bounds, setBounds] = useState({ min: 1.5, max: 64, default: 5.5 });
  const [savedAt, setSavedAt] = useState<number | undefined>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ok, setOk] = useState(false);
  const [error, setError] = useState("");

  // Gate the button on admin/superadmin. Detection goes through the editor's own route so it
  // doesn't depend on the launch param scheme (baseUrl vs vappHost vs same-origin) — the token
  // is always in the URL, and the server resolves the vApp base. Same check the PUT enforces.
  useEffect(() => {
    const { baseUrl, token } = vappCtx();
    if (!token) { console.log("[export-settings] no token in URL → button hidden"); return; }
    let alive = true;
    (async () => {
      try {
        const q = new URLSearchParams({ token });
        if (baseUrl) q.set("baseUrl", baseUrl);
        const r = await fetch(`${EDITOR_BASE}/api/admin/whoami?${q.toString()}`, { cache: "no-store" });
        const d = await r.json().catch(() => ({}));
        console.log(`[export-settings] whoami → role="${d?.role ?? "(none)"}" allowed=${!!d?.superadmin} (http ${r.status})`);
        if (alive && d?.superadmin) setIsSuperadmin(true);
      } catch (e) {
        console.log("[export-settings] whoami failed:", e);
      }
    })();
    return () => { alive = false; };
  }, []);

  const loadCurrent = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const r = await fetch(`${EDITOR_BASE}/api/admin/export-settings`, { cache: "no-store" });
      const d = await r.json();
      setBudget(Number(d?.settings?.ramBudgetGB ?? 5.5));
      setSavedAt(d?.settings?.updatedAt);
      if (d?.bounds) setBounds(d.bounds);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (open) { setOk(false); loadCurrent(); } }, [open, loadCurrent]);

  const save = useCallback(async () => {
    const { baseUrl, token } = vappCtx();
    const val = Number(budget);
    if (!Number.isFinite(val)) { setError("Enter a number"); return; }
    setSaving(true); setError(""); setOk(false);
    try {
      const r = await fetch(`${EDITOR_BASE}/api/admin/export-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ramBudgetGB: val, baseUrl, token }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.message || `save failed (${r.status})`);
      setBudget(Number(d?.settings?.ramBudgetGB ?? val));
      setSavedAt(d?.settings?.updatedAt);
      setOk(true);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  }, [budget]);

  if (!isSuperadmin) return null;

  const val = Number(budget);
  const ffmpegN = Number.isFinite(val) && val > 0 ? Math.max(1, Math.floor(val / PER_FFMPEG_GB)) : 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          title="Export settings (admin)"
        >
          <SlidersHorizontal className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="z-[10000] w-80 p-4" sideOffset={6}>
        <div className="mb-3">
          <p className="text-sm font-semibold">Export settings</p>
          <p className="text-xs text-muted-foreground">
            Admin · applies to every export on this server
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="ram-budget" className="text-xs">
            RAM budget per export (GB)
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id="ram-budget"
              type="number"
              step="0.5"
              min={bounds.min}
              max={bounds.max}
              value={budget}
              disabled={loading}
              onChange={(e) => setBudget(e.target.value === "" ? "" : Number(e.target.value))}
              className="h-8"
            />
            <Button size="sm" className="h-8 shrink-0" onClick={save} disabled={saving || loading}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : ok ? <Check className="size-4" /> : "Save"}
            </Button>
          </div>

          <p className="text-xs text-muted-foreground leading-relaxed">
            {ffmpegN > 0 ? (
              <>≈ <span className="text-foreground font-medium">{ffmpegN} ffmpeg</span> in parallel
              (auto — clamped to whatever RAM is free at render time). More = faster, more RAM.</>
            ) : (
              <>Higher = more parallel encoders = faster, but more RAM.</>
            )}
          </p>
          <p className="text-[11px] text-muted-foreground">
            Range {bounds.min}–{bounds.max} GB. Video quality is fixed — this only trades speed for RAM.
          </p>

          {error && <p className="text-xs text-destructive">{error}</p>}
          {ok && !error && (
            <p className="text-xs text-emerald-500">
              Saved{savedAt ? ` · ${new Date(savedAt * 1000).toLocaleTimeString()}` : ""}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
