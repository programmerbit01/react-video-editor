import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger
} from "@/components/ui/popover";
import { ChevronDown, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import useStore from "../store/use-store";
import BasicCaption from "./style";
import { ICaption, ITrackItem } from "@designcombo/types";
import { dispatch } from "@designcombo/events";
import { EDIT_OBJECT } from "@designcombo/state";
import useLayoutStore from "../store/use-layout-store";
import useCaptionTranscribeStore from "./transcribe-store";
import { getTrackTranscript } from "../control-item/transcript-panel";
import {
  DEFAULT_STYLE,
  applyCaption,
  captionCountFor,
  removeCaption,
  transcribeMedia
} from "./generate";

/**
 * THE caption panel — the only place captions are made or styled.
 *
 * Captions used to have three entry points: this menu, a Captions tab on every video clip and
 * another on every audio clip. The two clip tabs each generated onto their own track, so
 * captioning a talking-head video AND its voiceover produced two sets stacked on screen, and
 * this menu just told you to go use one of them. The source dropdown below is what collapses
 * that: picking the speaker is a choice inside one panel, not a reason for three.
 */
export const Captions = () => {
  const { tracks, trackItemsMap, activeIds } = useStore();
  const { setTrackItem: setLayoutTrackItem } = useLayoutStore();
  const {
    resultsByMedia,
    setTranscriptResult,
    generatingByMedia,
    setGenerating,
    errorByMedia,
    setError,
    lastSourceId
  } = useCaptionTranscribeStore();

  const [sourceId, setSourceId] = useState<string>("");

  // Anything with an audible track can be captioned. Audio first: on an AI project the
  // narration is the thing actually being spoken, and captioning the video instead is how you
  // end up with two sets of subtitles for one voice.
  const sources = useMemo(() => {
    const items = Object.values(trackItemsMap as Record<string, any>).filter(
      (i) => (i?.type === "audio" || i?.type === "video") && i?.details?.src
    );
    return items.sort((a, b) => {
      if (a.type !== b.type) return a.type === "audio" ? -1 : 1;
      return (a.display?.from ?? 0) - (b.display?.from ?? 0);
    });
  }, [trackItemsMap]);

  const source = sources.find((s) => s.id === sourceId) ?? null;

  // Which clip the panel is showing, in order of precedence: the one selected right now, the
  // one you clicked before opening this panel, and only then the first source.
  //
  // `activeIds` alone can't carry the click, because opening any menu runs clearActiveSelection
  // (menu-list.tsx) — it's already empty by the time we mount. That's what lastSourceId is for:
  // editor.tsx records the click as it happens, before the menu wipes it.
  //
  // This has to be ONE effect. As two (remember-the-click / fall-back-to-first) they both fire
  // on the same mount, and the fallback — reading the sourceId of the render it was queued in,
  // still "" — overwrote the remembered clip every time.
  useEffect(() => {
    if (activeIds?.length === 1 && sources.some((s) => s.id === activeIds[0])) {
      setSourceId(activeIds[0]);
      return;
    }
    if (source) return;
    const pick = (lastSourceId && sources.find((s) => s.id === lastSourceId)) || sources[0];
    if (pick) setSourceId(pick.id);
  }, [activeIds?.[0], lastSourceId, sources, source]);

  // Selecting on the timeline flows INTO this dropdown (above), but not back out.
  //
  // Dispatching LAYER_SELECTION from here does select the clip — and the left sidebar shows
  // either the menu or the selected item's panel, never both (control-item.tsx: `if
  // (!trackItem) return <MenuItem/>`), so it also throws you out of the Captions panel you're
  // working in. Picking which voice to caption is not a request to leave.
  const pickSource = (id: string) => setSourceId(id);

  const src: string | undefined = source?.details?.src;
  // A transcript can live in the runtime store OR baked onto the item as
  // metadata.transcriptData (AI projects, Guided Text). getTrackTranscript checks both — reading
  // only the store meant a clip whose Guided Text was already generated still offered
  // "Generate", re-running a transcription that existed.
  const transcript = getTrackTranscript(source, resultsByMedia) ?? undefined;
  const isGenerating = src ? !!generatingByMedia[src] : false;
  const error = src ? errorByMedia[src] : undefined;
  const appliedCount = source
    ? captionCountFor(trackItemsMap as Record<string, any>, source.id)
    : 0;

  const captionTracks = (tracks as any[]).filter(
    (t) => t.metadata?.captionTrack || t.type === "caption"
  );
  const captionItems = captionTracks
    .flatMap((t) => t.items ?? [])
    .map((id: string) => (trackItemsMap as any)[id])
    .filter(Boolean) as (ITrackItem & ICaption)[];
  const firstCaption = captionItems[0] ?? null;

  // FloatingControl (Preset picker, font picker) needs trackItem in layout store.
  //
  // `layout.trackItem` is one global slot that editor.tsx, control-item.tsx and
  // control-item-horizontal.tsx all write too, and FloatingControl renders nothing while it's
  // empty — so clearing it is how you close somebody else's open picker. Two rules here:
  // never clear a slot we no longer hold, and don't clear on every id change. Applying a
  // preset rebuilds the caption items under fresh ids, which re-ran this effect: the cleanup
  // nulled the slot mid-flight and the picker the click came from vanished under the cursor.
  const heldCaptionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!firstCaption) return;
    heldCaptionRef.current = firstCaption.id;
    setLayoutTrackItem(firstCaption as any);
  }, [firstCaption?.id]);

  useEffect(
    () => () => {
      if (useLayoutStore.getState().trackItem?.id === heldCaptionRef.current) {
        setLayoutTrackItem(null);
      }
    },
    []
  );

  const applyToAll = () => {
    if (!firstCaption || captionItems.length <= 1) return;
    const { words, text, top, left, width, height, ...styleDetails } =
      (firstCaption as any).details ?? {};
    const payload: Record<string, any> = {};
    for (const item of captionItems) {
      if (item.id !== firstCaption.id) payload[item.id] = { details: styleDetails };
    }
    if (Object.keys(payload).length > 0) dispatch(EDIT_OBJECT, { payload });
  };

  const handleGenerate = async () => {
    if (!src || !source) return;
    setGenerating(src, true);
    setError(src, "");
    try {
      const durSec = Math.max(
        1,
        ((source.display?.to ?? 0) - (source.display?.from ?? 0)) / 1000
      );
      setTranscriptResult(src, await transcribeMedia(src, durSec));
    } catch (err: any) {
      setError(src, String(err?.message || "Generation failed"));
    } finally {
      setGenerating(src, false);
    }
  };

  /**
   * Best readable name for a media file, from its URL — "" when the URL carries no name.
   *
   * A vApp generation bakes its prompt into the filename —
   * `vapp_TS-…_P-the-history-of-guns-began_S-…wav` — so the name is sitting right there. Two
   * shapes carry nothing, though, and both are common in saved projects: files pulled from a
   * render job all land at `<job>/0.mp3`, and older projects wrap their real URL in
   * `/api/proxy?url=…`, whose last path segment is the word "proxy" on every single clip.
   */
  const nameFromSrc = (src: string): string => {
    const raw = String(src || "");
    const wrapped = raw.match(/[?&]url=([^&]+)/);
    if (wrapped) return nameFromSrc(decodeURIComponent(wrapped[1]));

    const file = decodeURIComponent(raw.split("?")[0].split("/").pop() || "");
    const prompt = file.match(/_P-(.+?)_S-/);
    if (prompt) return prompt[1].replace(/-+/g, " ").trim();
    const stem = file.replace(/\.[a-z0-9]+$/i, "");
    return /^\d*$/.test(stem) ? "" : stem.replace(/[-_]+/g, " ").trim();
  };

  // Two rows that read the same are worse than no name at all, so this falls all the way
  // through: the library's name, then whatever the URL can tell us, and only if both come up
  // empty a plain ordinal — never a repeat of the row above.
  const sourceLabel = (item: any) => {
    const icon = item.type === "audio" ? "🎵" : "🎬";
    const startS = Math.round((item.display?.from ?? 0) / 1000);
    const at = `${Math.floor(startS / 60)}:${String(startS % 60).padStart(2, "0")}`;
    const named =
      String(item.details?.name || "").trim() || nameFromSrc(item.details?.src);
    if (named) return `${icon} ${named.slice(0, 24)} · ${at}`;

    const sameType = sources.filter((s) => s.type === item.type);
    const kind = item.type === "audio" ? "Audio" : "Video";
    return `${icon} ${kind} ${sameType.indexOf(item) + 1} · ${at}`;
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b border-border/60 px-4 pb-3 pt-3">
        {sources.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            Add an audio or video clip to caption.
          </p>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span className="flex-1 text-xs text-muted-foreground">Source</span>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    className="flex h-8 w-40 items-center justify-between text-xs"
                    variant="secondary"
                    disabled={isGenerating}
                  >
                    <span className="truncate">{source ? sourceLabel(source) : "—"}</span>
                    <ChevronDown className="text-muted-foreground" size={14} />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-64 p-1">
                  {sources.map((item) => (
                    // PopoverClose — Radix leaves the popover open on clicks inside it, so
                    // without this the menu hangs around after you've already chosen.
                    <PopoverClose asChild key={item.id}>
                      <Button
                        variant={item.id === source?.id ? "default" : "ghost"}
                        size="sm"
                        className="w-full justify-start text-xs"
                        onClick={() => pickSource(item.id)}
                      >
                        {sourceLabel(item)}
                      </Button>
                    </PopoverClose>
                  ))}
                </PopoverContent>
              </Popover>
            </div>

            {transcript ? (
              <div className="flex items-center gap-2">
                <p className="flex-1 truncate text-[11px] text-muted-foreground">
                  {transcript.language?.toUpperCase() || "—"} ·{" "}
                  {transcript.segments.length} segments
                </p>
                {appliedCount > 0 ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 border-destructive/30 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => removeCaption(source)}
                  >
                    Remove
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => applyCaption(source, transcript, DEFAULT_STYLE)}
                  >
                    Apply Captions
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 text-xs"
                  onClick={handleGenerate}
                  disabled={isGenerating}
                >
                  {isGenerating ? "…" : "Regenerate"}
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                className="h-8 w-full text-xs"
                onClick={handleGenerate}
                disabled={isGenerating || !src}
              >
                {isGenerating ? (
                  <>
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    Transcribing…
                  </>
                ) : (
                  "Generate captions"
                )}
              </Button>
            )}

            {error && <p className="text-[11px] text-destructive">{error}</p>}
          </>
        )}
      </div>

      {firstCaption ? (
        <>
          {captionItems.length > 1 && (
            <div className="flex shrink-0 items-center justify-between px-4 pt-3 pb-1">
              <p className="text-xs text-muted-foreground">{captionItems.length} captions</p>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={applyToAll}>
                Apply style to all
              </Button>
            </div>
          )}
          <BasicCaption trackItem={firstCaption} />
        </>
      ) : (
        <p className="p-6 text-center text-xs text-muted-foreground/70">
          Generate captions above, then style them here.
        </p>
      )}
    </div>
  );
};
