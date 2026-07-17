"use client";

// Navbar user menu. Always visible once you're signed in: shows your name + role, so you can
// see at a glance who you are and whether you have admin rights. Admins/superadmins additionally
// get "Export settings" here — the ONE knob is the RAM budget an export may use, from which the
// ffmpeg/worker parallelism derives (the render routes clamp it to actually-free RAM). No quality
// levers (those bring back the shaky-video / OOM tradeoffs). Saved server-side; applies to every
// export this machine runs.

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Check, Loader2 } from "lucide-react";
import { vappCtx } from "@/utils/vapp-api";

const PER_FFMPEG_GB = 0.95; // mirrors the FF route's per-segment cost, for the "≈ N ffmpeg" hint
const EDITOR_BASE = process.env.NEXT_PUBLIC_BASE_PATH || "/editor";

interface VappUser { name: string; email: string; role: string }

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

export default function UserMenu() {
  const [user, setUser] = useState<VappUser | null>(null);
  const [allowed, setAllowed] = useState(false);
  const [open, setOpen] = useState(false);

  const [budget, setBudget] = useState<number | "">("");
  const [bounds, setBounds] = useState({ min: 1.5, max: 64, default: 5.5 });
  const [savedAt, setSavedAt] = useState<number | undefined>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ok, setOk] = useState(false);
  const [error, setError] = useState("");

  // Who am I? Reveals the menu and whether admin controls show. The server resolves the vApp
  // base, so this works under any launch scheme (baseUrl / vappHost / same-origin).
  useEffect(() => {
    const { baseUrl, token } = vappCtx();
    if (!token) { console.log("[user-menu] no token in URL → menu hidden"); return; }
    let alive = true;
    (async () => {
      try {
        const q = new URLSearchParams({ token });
        if (baseUrl) q.set("baseUrl", baseUrl);
        const r = await fetch(`${EDITOR_BASE}/api/admin/whoami?${q.toString()}`, { cache: "no-store" });
        const d = await r.json().catch(() => ({}));
        console.log(`[user-menu] whoami → name="${d?.user?.name ?? "?"}" role="${d?.role ?? "(none)"}" admin=${!!d?.allowed} (http ${r.status})`);
        if (!alive) return;
        if (d?.ok && d?.user) { setUser(d.user); setAllowed(!!d.allowed); }
      } catch (e) {
        console.log("[user-menu] whoami failed:", e);
      }
    })();
    return () => { alive = false; };
  }, []);

  const loadSettings = useCallback(async () => {
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

  useEffect(() => { if (open && allowed) { setOk(false); loadSettings(); } }, [open, allowed, loadSettings]);

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

  if (!user) return null;

  const val = Number(budget);
  const ffmpegN = Number.isFinite(val) && val > 0 ? Math.max(1, Math.floor(val / PER_FFMPEG_GB)) : 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          className="flex h-8 items-center gap-2 px-1.5 text-muted-foreground hover:text-foreground"
          title={`${user.name} · ${user.role || "user"}`}
        >
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-secondary text-[10px] font-medium text-foreground">
            {initials(user.name)}
          </span>
          <span className="hidden lg:inline text-xs max-w-[120px] truncate">{user.name}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="z-[10000] w-80 p-0" sideOffset={6}>
        <div className="flex items-center gap-3 border-b border-border/60 p-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-secondary text-xs font-medium">
            {initials(user.name)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{user.name}</p>
            {user.email && <p className="truncate text-xs text-muted-foreground">{user.email}</p>}
          </div>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${allowed ? "bg-emerald-500/15 text-emerald-500" : "bg-secondary text-muted-foreground"}`}>
            {user.role || "user"}
          </span>
        </div>

        {allowed ? (
          <div className="space-y-2 p-4">
            <Label htmlFor="ram-budget" className="text-xs font-semibold">Export settings</Label>
            <p className="text-[11px] text-muted-foreground">RAM budget per export — applies to every export on this server.</p>
            <div className="flex items-center gap-2 pt-1">
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
              <span className="text-xs text-muted-foreground shrink-0">GB</span>
              <Button size="sm" className="h-8 shrink-0" onClick={save} disabled={saving || loading}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : ok ? <Check className="size-4" /> : "Save"}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {ffmpegN > 0
                ? <>≈ <span className="text-foreground font-medium">{ffmpegN} ffmpeg</span> in parallel (auto, clamped to free RAM). Higher = faster, more RAM.</>
                : <>Higher = more parallel encoders = faster, more RAM.</>}
            </p>
            <p className="text-[11px] text-muted-foreground">Range {bounds.min}–{bounds.max} GB. Video quality is fixed.</p>
            {error && <p className="text-xs text-destructive">{error}</p>}
            {ok && !error && (
              <p className="text-xs text-emerald-500">Saved{savedAt ? ` · ${new Date(savedAt * 1000).toLocaleTimeString()}` : ""}</p>
            )}
          </div>
        ) : (
          <div className="p-3 text-xs text-muted-foreground">
            Signed in. Export settings are available to admins.
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
