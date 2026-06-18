import { NextResponse } from "next/server";

type NLEEditor = "fcpx" | "premiere" | "resolve" | "otio";
type TrackItem = any;
type Track = any;
type Clip = any;
type Gap = any;
type Timeline = any;

// Convert design JSON (Vapp) → @chatoctopus/timeline Timeline model → FCPXML/XMEML/OTIO
export async function POST(request: Request) {
  try {
    const { exportTimeline, rational, ZERO, FRAME_RATES } = await import("@chatoctopus/timeline");

    const body = await request.json();
    const { design, format = "fcpx", mediaMode = "remote" } = body as {
      design: any;
      format: NLEEditor;
      mediaMode?: "remote" | "local";
    };

    if (!design) return NextResponse.json({ message: "design required" }, { status: 400 });

    const fps = Number(design.fps) || 30;
    const width = Number(design.size?.width) || 1920;
    const height = Number(design.size?.height) || 1080;
    const frameRate = FRAME_RATES["30"];

    const msToRational = (ms: number) => {
      const frames = Math.round((ms / 1000) * fps);
      return rational(frames, fps);
    };

    // If src is a proxy URL (/api/proxy?url=<encoded>), extract the real URL
    const resolveMediaUrl = (s: string): string => {
      if (!s) return s;
      if (s.startsWith("http")) return s;
      try {
        const proxyMatch = s.match(/[?&]url=([^&]+)/);
        if (proxyMatch) return decodeURIComponent(proxyMatch[1]);
      } catch {}
      return s;
    };

    const itemsMap: Record<string, any> = design.trackItemsMap ?? {};

    // Track media files for local mode (url → deduplicated filename)
    const mediaFiles: Array<{ filename: string; url: string }> = [];
    const urlToFilename = new Map<string, string>();
    const usedFilenames = new Set<string>();

    const getLocalFilename = (url: string): string => {
      if (urlToFilename.has(url)) return urlToFilename.get(url)!;
      const raw = url.split("/").pop()?.split("?")[0] ?? "media";
      let name = raw;
      let counter = 1;
      while (usedFilenames.has(name)) {
        const dot = raw.lastIndexOf(".");
        name = dot >= 0 ? `${raw.slice(0, dot)}_${counter}${raw.slice(dot)}` : `${raw}_${counter}`;
        counter++;
      }
      usedFilenames.add(name);
      urlToFilename.set(url, name);
      mediaFiles.push({ filename: name, url });
      return name;
    };

    const allClips = Object.values(itemsMap)
      .filter((item: any) => ["video", "audio", "image"].includes(item.type))
      .sort((a: any, b: any) => (a.display?.from ?? 0) - (b.display?.from ?? 0));

    const videoClips = allClips.filter((i: any) => i.type === "video" || i.type === "image");
    const audioClips = allClips.filter((i: any) => i.type === "audio");

    const buildTrackItems = (clips: any[]): TrackItem[] => {
      const result: TrackItem[] = [];
      let cursor = 0;

      for (const clip of clips) {
        const from = Number(clip.display?.from ?? 0);
        const to = Number(clip.display?.to ?? 0);
        if (to <= from) continue;

        if (from > cursor) {
          const gap: Gap = {
            kind: "gap",
            sourceRange: { startTime: ZERO, duration: msToRational(from - cursor) },
          };
          result.push(gap);
        }

        const trimFrom = Number(clip.trim?.from ?? 0);
        const clipDurationMs = to - from;
        const rawSrc: string = clip.details?.src ?? "";
        const resolvedUrl = resolveMediaUrl(rawSrc);

        let targetUrl = resolvedUrl;
        if (mediaMode === "local" && resolvedUrl) {
          const filename = getLocalFilename(resolvedUrl);
          targetUrl = `./media/${filename}`;
        }

        const availableDurationMs = trimFrom + clipDurationMs;

        const mediaRef = resolvedUrl
          ? {
              type: "external" as const,
              name: resolvedUrl.split("/").pop()?.split("?")[0] ?? "media",
              targetUrl,
              mediaKind: (clip.type === "image" ? "image" : "video") as "video" | "image",
              availableRange: {
                startTime: ZERO,
                duration: msToRational(availableDurationMs),
              },
            }
          : { type: "missing" as const, name: clip.name ?? "missing" };

        const clipItem: Clip = {
          kind: "clip",
          name: clip.name || clip.id || "clip",
          enabled: true,
          mediaReference: mediaRef,
          sourceRange: {
            startTime: msToRational(trimFrom),
            duration: msToRational(clipDurationMs),
          },
        };

        result.push(clipItem);
        cursor = to;
      }

      return result;
    };

    const tracks: Track[] = [];
    if (videoClips.length > 0) {
      tracks.push({ kind: "video", name: "V1", items: buildTrackItems(videoClips) });
    }
    if (audioClips.length > 0) {
      tracks.push({ kind: "audio", name: "A1", items: buildTrackItems(audioClips) });
    }

    if (tracks.length === 0) {
      return NextResponse.json({ message: "No video or audio clips found in design" }, { status: 400 });
    }

    const projectName = (design.name as string | undefined)?.trim() || "Vapp Export";

    const timeline: Timeline = {
      name: projectName,
      format: { width, height, frameRate, audioRate: 48000 },
      tracks,
    };

    const warnings: string[] = [];
    let xmlOutput: string = exportTimeline(timeline, format, {
      onWarning: (msg) => warnings.push(msg),
    });

    // Fix paths for local mode: library resolves ./media/ → absolute server path.
    // Replace back to relative so NLEs find media next to the project file.
    if (mediaMode === "local") {
      const cwd = process.cwd().replace(/\\/g, "/");
      xmlOutput = xmlOutput
        .replace(new RegExp(`file://${cwd}/media/`, "g"), "./media/")
        .replace(/file:\/\/\/[^"']*\/media\//g, "./media/");
    }

    const ext = format === "fcpx" ? "fcpxml" : format === "otio" ? "otio" : "xml";

    // Local mode: return JSON so client can build ZIP
    if (mediaMode === "local") {
      return NextResponse.json({
        xml: xmlOutput,
        ext,
        projectName,
        mediaFiles,
        warnings,
      });
    }

    // Remote mode: return file directly
    const filename = `${projectName}.${ext}`;
    const contentType = format === "otio" ? "application/json" : "application/xml";
    return new Response(xmlOutput, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "X-Export-Warnings": warnings.join("; "),
      },
    });
  } catch (err) {
    console.error("[export-timeline]", err);
    return NextResponse.json({ message: String(err) }, { status: 500 });
  }
}
