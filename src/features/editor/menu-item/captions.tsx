import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { useEffect, useState } from "react";
import { dispatch } from "@designcombo/events";
import { ITrackItem, ITrackItemsMap } from "@designcombo/types";
import { millisecondsToHHMMSS } from "../utils/format";
import useStore from "../store/use-store";
import { groupBy } from "lodash";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PLAYER_SEEK } from "../constants/events";
import { useCurrentPlayerFrame } from "../hooks/use-current-frame";
import { Loader2 } from "lucide-react";
import useCaptionTranscribeStore, {
  TranscriptResult,
  TranscriptSegment
} from "../store/use-caption-transcribe-store";

const getVappParams = () => {
  if (typeof window === "undefined") return { token: "", baseUrl: "" };
  const p = new URLSearchParams(window.location.search);
  return {
    token: p.get("token") || "",
    baseUrl: p.get("baseUrl") || ""
  };
};

export const Captions = () => {
  const { trackItemsMap } = useStore();
  const {
    pendingMediaSrc,
    clearPendingRequest,
    setTranscriptResult,
    resultsByMedia
  } = useCaptionTranscribeStore();
  const [selectMediaItems, setSelectMediaItems] = useState<
    { label: string; value: string }[]
  >([]);
  const [selectedMedia, setSelectedMedia] = useState<string | undefined>();
  const [captionTrackItemsMap, setCaptionTrackItemsMap] = useState<
    Record<string, ITrackItem[]>
  >({});
  const [mediaTrackItems, setMediaTrackItems] = useState<ITrackItem[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const selectedTrackItem = mediaTrackItems.find(
    (item) => item.details.src === selectedMedia
  );
  const selectedStoredTranscript = selectedTrackItem?.metadata?.transcriptData as
    | TranscriptResult
    | undefined;

  useEffect(() => {
    const mediaTrackItems = fetchMediaTrackItems(trackItemsMap);
    setMediaTrackItems(mediaTrackItems);

    const selectMediaOptions = createSelectMediaOptions(mediaTrackItems);
    setSelectMediaItems(selectMediaOptions);

    const groupedCaptions = groupCaptionItems(trackItemsMap);

    for (const key of Object.keys(groupedCaptions)) {
      const captions = groupedCaptions[key];
      const orderedCaptionByDisplayFrom = captions.sort(
        (a, b) => a.display.from - b.display.from
      );
      console.log({ orderedCaptionByDisplayFrom });
      groupedCaptions[key] = orderedCaptionByDisplayFrom as ITrackItem[];
    }
    setCaptionTrackItemsMap(groupedCaptions);
  }, [trackItemsMap]);

  useEffect(() => {
    if (!pendingMediaSrc) return;
    const matchedItem = mediaTrackItems.find(
      (item) => item.details.src === pendingMediaSrc
    );
    if (!matchedItem) return;

    setSelectedMedia(pendingMediaSrc);
    clearPendingRequest();

    if (!resultsByMedia[pendingMediaSrc] && !captionTrackItemsMap[pendingMediaSrc]) {
      void createCaptions(pendingMediaSrc);
    }
  }, [
    pendingMediaSrc,
    mediaTrackItems,
    clearPendingRequest,
    resultsByMedia,
    captionTrackItemsMap
  ]);

  const handleSelectChange = (value: string) => {
    setSelectedMedia(value);
  };

  const createCaptions = async (selectedMedia: string) => {
    setIsGenerating(true);
    try {
      const trackItem = mediaTrackItems.find(
        (m) => m.details.src === selectedMedia
      );

      if (!trackItem) {
        throw new Error("Track item not found");
      }

      const { url, result } = await transcribeMedia(selectedMedia, "");
      const jsonData = result || (url ? await fetchJsonFromUrl(url) : null);
      if (!jsonData) {
        throw new Error("Transcription result missing");
      }
      const transcriptResult = normalizeTranscriptResult(
        jsonData,
        Math.max(1, (trackItem.display.to - trackItem.display.from) / 1000)
      );
      setTranscriptResult(selectedMedia, transcriptResult);
    } catch (error) {
      console.error("Error generating captions:", error);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      {mediaTrackItems.length === 0 ? (
        <EmptyMediaTrackItems />
      ) : (
        <MediaSection
          selectMediaItems={selectMediaItems}
          selectedMedia={selectedMedia}
          onSelectChange={handleSelectChange}
          captionTrackItemsMap={captionTrackItemsMap}
          transcriptResult={
            (selectedMedia ? resultsByMedia[selectedMedia] : undefined) ||
            selectedStoredTranscript
          }
          createCaptions={createCaptions}
          isGenerating={isGenerating}
        />
      )}
    </div>
  );
};

const MediaSection = ({
  selectMediaItems,
  selectedMedia,
  onSelectChange,
  captionTrackItemsMap,
  transcriptResult,
  createCaptions,
  isGenerating
}: {
  selectMediaItems: { label: string; value: string }[];
  selectedMedia: string | undefined;
  onSelectChange: (value: string) => void;
  captionTrackItemsMap: Record<string, ITrackItem[]>;
  transcriptResult?: TranscriptResult;
  createCaptions: (selectedMedia: string) => void;
  isGenerating: boolean;
}) => (
  <div className="flex h-[calc(100%-4.5rem)] flex-col gap-4 px-4">
    <Select value={selectedMedia} onValueChange={onSelectChange}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder="Select media" />
      </SelectTrigger>
      <SelectContent className="z-[200]">
        {selectMediaItems.map((item) => (
          <SelectItem value={item.value} key={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>

    {selectedMedia ? (
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        {transcriptResult ? (
          <TranscriptResultCard transcriptResult={transcriptResult} />
        ) : null}

        {captionTrackItemsMap[selectedMedia] ? (
          <div className="min-h-0 flex-1">
            <ScrollArea className="h-full">
              <MediaWithCaptions
                captionTrackItems={captionTrackItemsMap[selectedMedia]}
              />
            </ScrollArea>
          </div>
        ) : (
          <MediaWithNoCaptions
            createCaptions={() => createCaptions(selectedMedia)}
            isGenerating={isGenerating}
          />
        )}
      </div>
    ) : (
      <MediaNoSelected />
    )}
  </div>
);

const TranscriptResultCard = ({
  transcriptResult
}: {
  transcriptResult: TranscriptResult;
}) => (
  <div className="rounded-lg border border-border/70 bg-card/60 p-3">
    <div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>
        {transcriptResult.language?.toUpperCase() || "—"} ·{" "}
        {transcriptResult.segment_count || transcriptResult.segments.length} segments
      </span>
      <span>Transcription</span>
    </div>
    <div className="mb-3 text-sm leading-6">
      {transcriptResult.text || "No text found."}
    </div>
    {transcriptResult.segments.length > 0 ? (
      <div className="space-y-2">
        {transcriptResult.segments.map((segment, index) => (
          <TranscriptSegmentItem
            key={`${segment.start}-${segment.end}-${index}`}
            segment={segment}
          />
        ))}
      </div>
    ) : null}
  </div>
);

const TranscriptSegmentItem = ({
  segment
}: {
  segment: TranscriptSegment;
}) => {
  const handleSeek = (timeSeconds: number) => {
    dispatch(PLAYER_SEEK, { payload: { time: timeSeconds * 1000 } });
  };

  return (
    <button
      type="button"
      className="flex w-full flex-col rounded-md bg-background/50 p-2 text-left hover:bg-background"
      onClick={() => handleSeek(segment.start)}
    >
      <div className="text-[11px] text-muted-foreground">
        {millisecondsToHHMMSS(segment.start * 1000)} -{" "}
        {millisecondsToHHMMSS(segment.end * 1000)}
      </div>
      <div className="text-sm">{segment.text}</div>
    </button>
  );
};

const MediaNoSelected = () => (
  <div className="text-center text-sm text-muted-foreground">
    Select video or audio and generate transcript guides automatically.
  </div>
);

const EmptyMediaTrackItems = () => (
  <div className="text-center text-sm text-muted-foreground">
    Add video or audio and generate transcript guides automatically.
  </div>
);

const MediaWithNoCaptions = ({
  createCaptions,
  isGenerating
}: {
  createCaptions: () => void;
  isGenerating: boolean;
}) => (
  <div className="flex flex-col gap-2 px-4">
    <div className="text-center text-sm text-muted-foreground">
      Recognize speech in the selected video/audio and generate an attached
      timeline transcript guide automatically.
    </div>
    <Button
      onClick={createCaptions}
      variant="default"
      className="w-full"
      disabled={isGenerating}
    >
      {isGenerating ? (
        <>
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Generating...
        </>
      ) : (
        "Generate"
      )}
    </Button>
  </div>
);

const MediaWithCaptions = ({
  captionTrackItems
}: {
  captionTrackItems: ITrackItem[];
}) => {
  const { playerRef } = useStore();
  const currentFrame = useCurrentPlayerFrame(playerRef || null);

  return (
    <div className="flex flex-col gap-2">
      {captionTrackItems.map((item) => (
        <CaptionItem
          isActive={
            currentFrame * (1000 / 30) >= item.display.from &&
            currentFrame * (1000 / 30) <= item.display.to
          }
          key={item.id}
          item={item}
        />
      ))}
    </div>
  );
};
const CaptionItem = ({
  item,
  isActive
}: {
  item: ITrackItem;
  isActive?: boolean;
}) => {
  const { display, details } = item;
  // const [timeline, setTimeline] = useState(0);
  // const { fps, playerRef } = useStore();
  // const currentFrame = useCurrentPlayerFrame(playerRef!);
  // const [inRange, setInRange] = useState(false);
  // useEffect(() => {
  //   setTimeline(currentFrame / fps);
  // }, [currentFrame, fps]);

  // const isInRange = useCallback(() => {
  //   return timeline >= display.from / 1000 && timeline <= display.to / 1000;
  // }, [timeline, display.from, display.to]);

  // useEffect(() => {
  //   setInRange(isInRange());
  // }, [timeline, isInRange]);

  const handleSeek = (time: number) => {
    dispatch(PLAYER_SEEK, { payload: { time: time } });
  };
  return (
    <div
      className={`flex flex-col gap-2 rounded-lg p-2 hover:cursor-pointer hover:bg-slate-900 ${
        isActive
          ? "bg-captions-background text-captions-text"
          : "text-muted-foreground"
      }`}
      onClick={() => handleSeek(display.from)}
    >
      <div className="flex flex-col gap-1">
        <div className="text-xs">
          {millisecondsToHHMMSS(display.from)} -{" "}
          {millisecondsToHHMMSS(display.to)}
        </div>
        <div className="text-sm">{details.text}</div>
      </div>
    </div>
  );
};
// Helper functions
const fetchMediaTrackItems = (trackItemsMap: ITrackItemsMap) => {
  return Object.values(trackItemsMap).filter(
    ({ type }: ITrackItem) => type === "audio" || type === "video"
  );
};

const createSelectMediaOptions = (mediaTrackItems: ITrackItem[]) => {
  return mediaTrackItems.map(({ name, details }) => ({
    label: name,
    value: details.src
  }));
};

const groupCaptionItems = (trackItemsMap: ITrackItemsMap) => {
  const captionTrackItems = Object.values(trackItemsMap).filter(
    ({ type }: ITrackItem) => type === "caption"
  );
  return groupBy(captionTrackItems, "metadata.sourceUrl");
};

const withEditorBase = (path: string) => {
  if (typeof window === "undefined") return path;
  return window.location.pathname.startsWith("/editor") ? `/editor${path}` : path;
};

async function transcribeMedia(
  mediaUrl: string,
  targetLanguage: string
): Promise<{ url: string; result?: any }> {
  const { token, baseUrl } = getVappParams();
  const transcribeResponse = await fetch(withEditorBase("/api/transcribe"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      url: mediaUrl,
      timestamp_type: "word",
      targetLanguage,
      token,
      baseUrl
    })
  });

  if (!transcribeResponse.ok) {
    throw new Error("Failed to initiate transcription.");
  }

  const transcribeData = await transcribeResponse.json();
  const { transcribe } = transcribeData;

  return { url: transcribe.url, result: transcribe.result };
}

async function fetchJsonFromUrl(url: string) {
  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Error fetching JSON: ${response.statusText}`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Failed to fetch JSON data:", error);
    throw error; // Optionally rethrow to handle it in the caller
  }
}

function normalizeTranscriptResult(
  input: any,
  fallbackDurationSeconds: number
): TranscriptResult {
  const text = String(input?.text || "").trim();
  const language = String(input?.language || "").trim();
  const rawSegments = Array.isArray(input?.segments) ? input.segments : [];

  const segments: TranscriptSegment[] =
    rawSegments.length > 0
      ? rawSegments
          .map((segment: any) => ({
            start: Number(segment?.start || 0),
            end: Number(segment?.end || 0),
            text: String(segment?.text || "").trim(),
            words: Array.isArray(segment?.words)
              ? segment.words.map((word: any) => ({
                  word: String(word?.word || "").trim(),
                  start: Number(word?.start || 0),
                  end: Number(word?.end || 0)
                }))
              : undefined
          }))
          .filter((segment: TranscriptSegment) => segment.text)
      : text
        ? [
            {
              start: 0,
              end: Math.max(1, fallbackDurationSeconds || 1),
              text
            }
          ]
        : [];

  return {
    text,
    language,
    segment_count: Number(input?.segment_count || segments.length || 0),
    segments
  };
}
