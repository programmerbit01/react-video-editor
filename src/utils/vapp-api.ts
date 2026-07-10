// Direct vApp-server access for the editor — NO higgs proxy hop.
// The editor is launched with ?baseUrl=<public vApp server>&token=<vApp token>.
// The vApp server serves CORS `*` and authenticates via `Authorization: Bearer`,
// so the browser can hit it directly. higgs is out of the loop.

export function vappCtx(): { baseUrl: string; token: string } {
  if (typeof window === "undefined") return { baseUrl: "", token: "" };
  const p = new URLSearchParams(window.location.search);
  return {
    baseUrl: (p.get("baseUrl") || "").replace(/\/+$/, ""),
    token: p.get("token") || "",
  };
}

export function vappAuth(token?: string): Record<string, string> {
  const t = token ?? vappCtx().token;
  return t ? { Authorization: `Bearer ${t}` } : {};
}

// STT lookup straight from the vApp server (match a media url against job outputs).
// Media items usually already carry `stt`; this is the fallback path.
export async function sttForUrl(url: string): Promise<any | null> {
  const { baseUrl, token } = vappCtx();
  if (!baseUrl || !url) return null;
  try {
    const r = await fetch(`${baseUrl}/vapp/user/jobs?perPage=200`, {
      headers: vappAuth(token),
      cache: "no-store",
    });
    if (!r.ok) return null;
    const d = await r.json();
    const jobs: any[] = d?.items || d?.jobs || d?.data || [];
    for (const j of jobs) {
      const stt = j?.result?.stt;
      if (!stt || typeof stt !== "object") continue;
      const urls = [
        j?.output_url,
        j?.output_s3_url,
        j?.output_local_url,
        ...(Array.isArray(j?.output_urls) ? j.output_urls : []),
        ...((Array.isArray(j?.result?.files) ? j.result.files : []).map((f: any) => f?.url)),
      ].filter(Boolean);
      if (urls.some((u: string) => u === url || url.includes(u))) return stt;
    }
  } catch {}
  return null;
}
