import { NextResponse } from "next/server";
import type { Timeline, Track, TrackItem, Clip, Gap, NLEEditor } from "@chatoctopus/timeline";

// Convert design JSON (Vapp) → @chatoctopus/timeline Timeline model → FCPXML/XMEML/OTIO
export async function POST(request: Request) {
  try {
    const { exportTimeline, rational, ZERO, FRAME_RATES } = await import("@chatoctopus/timeline");

    const body = await request.json();
    const { design, format = "fcpx" } = body as { design: any; format: NLEEditor };

    if (!design) return NextResponse.json({ message: "design required" }, { status: 400 });

    const fps = Number(design.fps) || 30;
    const width = Number(design.size?.width) || 1920;
    const height = Number(design.size?.height) || 1080;
    const frameRate = FRAME_RATES["30"]; // rational(30, 1)

    const msToRational = (ms: number) => {
      // ms → seconds → frame-aligned rational
      const frames = Math.round((ms / 1000) * fps);
      return rational(frames, fps);
    };

    const itemsMap: Record<string, any> = design.trackItemsMap ?? {};

    // Build one video and one audio track per source track
    const videoItems: TrackItem[] = [];
    const audioItems: TrackItem[] = [];

    // Collect all video/audio clips sorted by timeline position
    const allClips = Object.values(itemsMap)
      .filter((item: any) => ["video", "audio", "image"].includes(item.type))
      .sort((a: any, b: any) => (a.display?.from ?? 0) - (b.display?.from ?? 0));

    // Sort by track ordering so items respect track lanes
    // For simplicity: video clips → V1 track, audio clips → A1 track
    // (Multi-track support would require more complex mapping)
    const videoClips = allClips.filter((i: any) => i.type === "video" || i.type === "image");
    const audioClips = allClips.filter((i: any) => i.type === "audio");

    const buildTrackItems = (clips: any[]): TrackItem[] => {
      const result: TrackItem[] = [];
      let cursor = 0; // current timeline position in ms

      for (const clip of clips) {
        const from = Number(clip.display?.from ?? 0);
        const to = Number(clip.display?.to ?? 0);
        if (to <= from) continue;

        // Insert gap if there's empty space before this clip
        if (from > cursor) {
          const gap: Gap = {
            kind: "gap",
            sourceRange: {
              startTime: ZERO,
              duration: msToRational(from - cursor),
            },
          };
          result.push(gap);
        }

        const trimFrom = Number(clip.trim?.from ?? 0);
        const clipDurationMs = to - from;
        const src: string = clip.details?.src ?? "";

        const mediaRef = src
          ? {
              type: "external" as const,
              name: src.split("/").pop() ?? "media",
              targetUrl: src.startsWith("http") ? src : `file://${src}`,
              mediaKind: (clip.type === "image" ? "image" : "video") as "video" | "image",
              availableRange: {
                startTime: msToRational(trimFrom),
                duration: msToRational(
                  Number(clip.trim?.to ?? clip.duration ?? clipDurationMs) - trimFrom
                ),
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
      tracks.push({
        kind: "video",
        name: "V1",
        items: buildTrackItems(videoClips),
      });
    }

    if (audioClips.length > 0) {
      tracks.push({
        kind: "audio",
        name: "A1",
        items: buildTrackItems(audioClips),
      });
    }

    if (tracks.length === 0) {
      return NextResponse.json({ message: "No video or audio clips found in design" }, { status: 400 });
    }

    const timeline: Timeline = {
      name: design.name ?? "Vapp Export",
      format: {
        width,
        height,
        frameRate,
        audioRate: 48000,
      },
      tracks,
    };

    const warnings: string[] = [];
    const output = exportTimeline(timeline, format, {
      onWarning: (msg) => warnings.push(msg),
    });

    const ext = format === "fcpx" ? "fcpxml" : format === "otio" ? "otio" : "xml";
    const filename = `vapp-export.${ext}`;
    const contentType = format === "otio" ? "application/json" : "application/xml";

    return new Response(output, {
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
