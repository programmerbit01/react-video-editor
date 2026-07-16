import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger
} from "@/components/ui/popover";

import { ChevronDown } from "lucide-react";

import { Label } from "@/components/ui/label";
import { useCallback, useEffect, useRef, useState } from "react";
import useLayoutStore from "../../store/use-layout-store";
import { ICaption, ITrackItem } from "@designcombo/types";
import useStore from "../../store/use-store";
import { groupCaptionItems } from "../presets";
import { dispatch } from "@designcombo/events";
import { EDIT_OBJECT } from "@designcombo/state";
import { generateId } from "@designcombo/timeline";
import { getStateManagerRef } from "../../utils/state-manager-ref";
import { debounce } from "lodash";

export function regroupCaptions(
  captions: ICaption[],
  newLinesPerCaption: number
): ICaption[] {
  const allWords = captions.flatMap((c) => c.details.words);
  if (allWords.length === 0) return [];

  const base = captions[0];
  const fontFamily = base.details.fontFamily || "Arial";
  const fontSize = base.details.fontSize || 16;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = `${fontSize}px ${fontFamily}`;

  const maxWidth = base.details.width - 80;

  const newCaptions: ICaption[] = [];
  let buffer: typeof allWords = [];
  let currentLineWidth = 0;
  let currentLineCount = 1;

  for (let i = 0; i < allWords.length; i++) {
    const word = allWords[i];
    const wordWidth = ctx.measureText(word.word).width;
    const spaceWidth = ctx.measureText(" ").width;

    let nextWidth =
      currentLineWidth === 0
        ? wordWidth
        : currentLineWidth + spaceWidth + wordWidth;

    if (nextWidth > maxWidth) {
      currentLineCount++;
      if (currentLineCount > newLinesPerCaption) {
        const text = buffer.map((w) => w.word).join(" ");
        const from = buffer[0].start;
        const to = buffer[buffer.length - 1].end;

        const newCaption: ICaption = {
          ...base,
          id: generateId(),
          display: { from, to },
          details: {
            ...base.details,
            text,
            linesPerCaption: newLinesPerCaption,
            words: [...buffer]
          }
        };

        newCaptions.push(newCaption);

        buffer = [];
        currentLineWidth = 0;
        currentLineCount = 1;
      } else {
        currentLineWidth = wordWidth;
      }
    } else {
      currentLineWidth = nextWidth;
    }

    buffer.push(word);

    if (i === allWords.length - 1 && buffer.length > 0) {
      const text = buffer.map((w) => w.word).join(" ");
      const from = buffer[0].start;
      const to = buffer[buffer.length - 1].end;

      const newCaption: ICaption = {
        ...base,
        id: generateId(),
        display: { from, to },
        details: {
          ...base.details,
          text,
          linesPerCaption: newLinesPerCaption,
          words: [...buffer]
        }
      };
      newCaptions.push(newCaption);
    }
  }

  return newCaptions;
}
type CaptionTransformType = "punctuationOrPause" | "time" | "singleWord";

export function transformCaptions(
  captions: ICaption[],
  type: CaptionTransformType
): ICaption[] {
  if (!captions.length) return [];

  const allWords = captions.flatMap((c) => c.details.words);

  const base = captions[0];

  const makeCaption = (words: any[]): ICaption => {
    const text = words.map((w) => w.word).join(" ");
    return {
      ...base,
      id: generateId(),
      display: { from: words[0].start, to: words[words.length - 1].end },
      details: {
        ...base.details,
        text,
        words,
        wordsPerLine: type,
        linesPerCaption: 1
      }
    };
  };

  switch (type) {
    case "singleWord":
      return allWords.map((word) => makeCaption([{ ...word }]));

    case "punctuationOrPause":
      const result: ICaption[] = [];
      let buffer: any[] = [];

      for (let i = 0; i < allWords.length; i++) {
        const word = allWords[i];
        const nextWord = allWords[i + 1];

        buffer.push(word);

        let shouldSplit = false;

        if (nextWord) {
          const gap = nextWord.start - word.end;
          if (gap >= 150) {
            shouldSplit = true;
          }
        }

        if (
          !shouldSplit &&
          (/[.,!?;]/.test(word.word) || word.word.endsWith("."))
        ) {
          shouldSplit = true;
        }

        if (shouldSplit) {
          result.push(makeCaption([...buffer]));
          buffer = [];
        }
      }

      if (buffer.length > 0) {
        result.push(makeCaption(buffer));
      }
      return result;

    case "time":
      const interval = 500; // ms (0.5s)
      const chunks: ICaption[] = [];
      let currentStart = allWords[0]?.start || 0;
      let wordIndex = 0;

      while (
        currentStart < (allWords[allWords.length - 1]?.end || 0) &&
        wordIndex < allWords.length
      ) {
        const currentEnd = Math.min(
          currentStart + interval,
          allWords[allWords.length - 1]?.end || 0
        );
        const chunkWords: any[] = [];

        // Collect words that fall within this time interval
        while (
          wordIndex < allWords.length &&
          allWords[wordIndex].start < currentEnd
        ) {
          chunkWords.push(allWords[wordIndex]);
          wordIndex++;
        }

        if (chunkWords.length > 0) {
          chunks.push(makeCaption(chunkWords));
        }

        currentStart = currentEnd;
      }

      return chunks;

    default:
      return captions;
  }
}
const OPTIONS_LINES_PER_PAGE = [
  {
    label: "One",
    value: 1
  },
  {
    label: "Two",
    value: 2
  },

  {
    label: "Three",
    value: 3
  },

  {
    label: "Four",
    value: 4
  },

  {
    label: "Five",
    value: 5
  }
];

const OPTIONS_WORDS_PER_LINE = [
  {
    label: "Punctuation",
    value: "punctuationOrPause"
  },
  {
    label: "Time",
    value: "time"
  },
  {
    label: "Single Word",
    value: "singleWord"
  }
];

const OPTIONS_WORDS_IN_LINE = [
  {
    label: "Page",
    value: "page"
  },
  {
    label: "Line",
    value: "line"
  },
  {
    label: "Word",
    value: "word"
  }
];
const CaptionWords = ({
  handleModalAnimation,
  trackItem
}: {
  id: string;
  handleModalAnimation: (newState?: boolean) => void;
  trackItem: ITrackItem & any;
}) => {
  const { setFloatingControl } = useLayoutStore();
  const { trackItemsMap, size } = useStore();
  const [captionsData, setCaptionsData] = useState<any[]>([]);
  const [captionItemIds, setCaptionItemIds] = useState<string[]>([]);
  const [topPosition, setTopPosition] = useState<string>(() => {
    const topValue = trackItem?.details.top;
    if (topValue === undefined) return "800";
    if (typeof topValue === "string") return topValue.replace("px", "");
    return String(topValue);
  });
  const [leftPosition, setLeftPosition] = useState<string>(() => {
    const leftValue = trackItem?.details.left;
    if (leftValue === undefined) {
      return String((size.width - elementWidth) / 2);
    }
    if (typeof leftValue === "string") return leftValue.replace("px", "");
    return String(leftValue);
  });
  const [data, setData] = useState<{
    linesPerCaption: number;
    wordsPerLine: string;
    captionsTransitions: string;
    showObject: string;
  }>({
    linesPerCaption: trackItem?.details?.linesPerCaption || 2,
    wordsPerLine: trackItem?.details?.wordsPerLine || "punctuationOrPause",
    captionsTransitions: "none",
    showObject: trackItem?.details?.showObject || "page"
  });

  const rawWidth = trackItem?.details.width as string | number | undefined;

  const elementWidth = Number(
    typeof rawWidth === "string" ? rawWidth.replace("px", "") : rawWidth || 0
  );
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const groupedCaptions = groupCaptionItems(trackItemsMap);

    // Optional-chain `metadata` — see the same guard in preset-caption.tsx. An unguarded read
    // threw on any caption our AI generator wrote (metadata:null) and, with no ErrorBoundary
    // above it, took the whole editor down rather than just this panel.
    const currentGroupItems = groupedCaptions[trackItem?.metadata?.sourceUrl] ?? [];
    setCaptionItemIds(currentGroupItems.map((item) => item.id));
    setCaptionsData(currentGroupItems);
  }, [trackItemsMap, trackItem]);

  useEffect(() => {
    const handleClick = (event: Event) => {
      if (
        popoverRef.current &&
        event.target instanceof Node &&
        !popoverRef.current.contains(event.target)
      ) {
        handleModalAnimation(false);
      }
    };

    document.addEventListener("mousedown", handleClick);
    return () => {
      document.removeEventListener("mousedown", handleClick);
    };
  }, []);

  /**
   * Swap a caption group's items for re-cut ones, keeping the track they live on.
   *
   * Re-segmenting genuinely produces new items, so the old ones do have to go — but they belong
   * on the SAME row. This used to LAYER_DELETE + ADD_ITEMS under a fresh `generateId()` track,
   * which stranded the caption row and appended a new one above the clips it belonged under.
   */
  const replaceCaptionItems = (oldItems: any[], newItems: any[]) => {
    const sm = getStateManagerRef();
    if (!sm || !newItems.length) return;
    const state = sm.getState();
    const oldIds = new Set<string>(oldItems.map((item: any) => item.id));

    const trackItemsMap = { ...(state?.trackItemsMap || {}) };
    oldIds.forEach((id) => delete trackItemsMap[id]);
    newItems.forEach((item: any) => {
      trackItemsMap[item.id] = item;
    });

    const trackItemIds = [
      ...(Array.isArray(state?.trackItemIds) ? state.trackItemIds : []).filter(
        (id: string) => !oldIds.has(id)
      ),
      ...newItems.map((item: any) => item.id)
    ];

    let seated = false;
    const tracks = (Array.isArray(state?.tracks) ? state.tracks : []).map((t: any) => {
      if (t?.type !== "caption") return t;
      const list: string[] = Array.isArray(t.items) ? t.items : [];
      const kept = list.filter((id: string) => !oldIds.has(id));
      if (!list.some((id: string) => oldIds.has(id))) return { ...t, items: kept };
      seated = true;
      return { ...t, items: [...kept, ...newItems.map((item: any) => item.id)] };
    });
    // Nothing owned them — land on the first caption row rather than mint one (minting is what
    // made the row jump). If there's no caption track at all, do nothing: silently relocating
    // the user's captions is worse than the dropdown appearing to no-op.
    if (!seated) {
      const idx = tracks.findIndex((t: any) => t?.type === "caption");
      if (idx < 0) return;
      tracks[idx] = {
        ...tracks[idx],
        items: [
          ...(Array.isArray(tracks[idx].items) ? tracks[idx].items : []),
          ...newItems.map((item: any) => item.id)
        ]
      };
    }

    sm.updateState({ tracks, trackItemIds, trackItemsMap }, { updateHistory: true });
  };

  const onChange = ({ type, value }: { type: string; value: any }) => {
    setData({ ...data, [type]: value });
    if (!captionsData?.length) return;

    // "Words in line" just flips a flag the renderer reads — it never re-cuts anything, so it
    // has no business deleting and re-adding items (which is what moved the row).
    if (type === "showObject") {
      const payload = captionsData.reduce(
        (acc, item) => ({ ...acc, [item.id]: { details: { showObject: value } } }),
        {}
      );
      dispatch(EDIT_OBJECT, { payload });
      return;
    }

    // These two DO re-cut the captions into different items — but onto the same track.
    const newData =
      type === "linesPerCaption"
        ? regroupCaptions(captionsData, value)
        : type === "wordsPerLine"
          ? transformCaptions(captionsData, value)
          : undefined;
    if (!newData?.length) return;
    replaceCaptionItems(captionsData, newData);
  };

  const handleSetPosition = useCallback(
    debounce((left: number, top: number) => {
      if (!captionsData?.length) return;
      const updates = captionsData.reduce(
        (acc, item) => ({
          ...acc,
          [item.id]: {
            details: { left, top }
          }
        }),
        {}
      );

      dispatch(EDIT_OBJECT, { payload: updates });
    }, 200),
    [captionsData]
  );

  const handlePresetPosition = (
    position: "left" | "center" | "right" | "up" | "middle" | "down"
  ) => {
    let left = 0;
    let top = 0;
    const elementHeight = trackItem?.details.height || 0;
    switch (position) {
      case "left":
        left = size.width * 0.1;
        // Keep current vertical position
        top = parseFloat(topPosition) || 0;
        break;
      case "center":
        left = (size.width - elementWidth) / 2;
        // Keep current vertical position
        top = parseFloat(topPosition) || 0;
        break;
      case "right":
        left = size.width * 0.9 - elementWidth;
        // Keep current vertical position
        top = parseFloat(topPosition) || 0;
        break;
      case "up":
        // Keep current horizontal position
        left = parseFloat(leftPosition) || 0;
        top = size.height * 0.1;
        break;
      case "middle":
        // Keep current horizontal position
        left = parseFloat(leftPosition) || 0;
        top = size.height / 2 - elementHeight / 2;
        break;
      case "down":
        // Keep current horizontal position
        left = parseFloat(leftPosition) || 0;
        top = size.height * 0.9 - elementHeight;
        break;
    }

    setTopPosition(String(top));
    setLeftPosition(String(left));
    handleSetPosition(left, top);
  };

  const animationOptions: { key: string; label: string }[] = [
    { key: "none", label: "None" },
    { key: "fade-in-full", label: "Fade" },
    { key: "scale-up-0", label: "Scale" },
    { key: "translate-x", label: "Slide" },
    { key: "scale-up-08", label: "Zoom" },
    { key: "scale-down-12", label: "Pop" },
    { key: "jump", label: "Jump" },
    { key: "pulse", label: "Pulse" }
  ];

  const [selectedOptions, setSelectedOptions] = useState<string[]>([]);

  function toggleOption(option: string) {
    setSelectedOptions((prev) => {
      let newOptions: string[];
      if (prev.includes(option)) {
        newOptions = [];
      } else {
        newOptions = [option];
      }

      const animationString = newOptions.length > 0 ? newOptions[0] : "none";
      selectAnimation(animationString);

      return newOptions;
    });
  }

  const selectAnimation = (animation: string) => {
    console.log("animation", animation);
    const payload = captionItemIds.reduce((acc, id) => {
      return {
        ...acc,
        [id]: {
          details: {
            animation
          }
        }
      };
    }, {});
    dispatch(EDIT_OBJECT, {
      payload
    });
  };

  return (
    <div className="flex flex-col gap-2 py-4">
      <Label className="font-sans text-xs font-semibold">Words</Label>

      <div className="flex gap-2">
        <div className="flex flex-1 items-center text-sm text-muted-foreground">
          Lines per Page
        </div>
        <div className="relative w-32">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                className="flex h-8 w-full items-center justify-between text-sm"
                variant="secondary"
              >
                <div className="w-full overflow-hidden text-left">
                  <p className="truncate">
                    {
                      OPTIONS_LINES_PER_PAGE.filter(
                        (option) => option.value === data.linesPerCaption
                      )[0].label
                    }
                  </p>
                </div>
                <ChevronDown className="text-muted-foreground" size={14} />
              </Button>
            </PopoverTrigger>

            <PopoverContent className="z-[300] w-32 p-0">
              {OPTIONS_LINES_PER_PAGE.map((option, index) => (
                <PopoverClose asChild>
                  <Button
                    size={"sm"}
                    variant="ghost"
                    className="w-full"
                    key={index}
                    onClick={() =>
                      onChange({ type: "linesPerCaption", value: option.value })
                    }
                  >
                    {option.label}
                  </Button>
                </PopoverClose>
              ))}
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <div className="flex gap-2">
        <div className="flex flex-1 items-center text-sm text-muted-foreground">
          Words per line
        </div>
        <div className="flex gap-2">
          <div className="relative w-32">
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  className="flex h-8 w-full items-center justify-between text-sm"
                  variant="secondary"
                >
                  <div className="w-full overflow-hidden text-left">
                    <p className="truncate">
                      {
                        OPTIONS_WORDS_PER_LINE.filter(
                          (option) => option.value === data.wordsPerLine
                        )[0].label
                      }
                    </p>
                  </div>
                  <ChevronDown className="text-muted-foreground" size={14} />
                </Button>
              </PopoverTrigger>

              <PopoverContent className="z-[300] w-32 p-0">
                {OPTIONS_WORDS_PER_LINE.map((option, index) => (
                  <PopoverClose asChild key={index}>
                    <Button
                      size={"sm"}
                      variant="ghost"
                      className="w-full truncate"
                      onClick={() =>
                        onChange({ type: "wordsPerLine", value: option.value })
                      }
                    >
                      {option.label}
                    </Button>
                  </PopoverClose>
                ))}
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </div>

      <div className="flex gap-2">
        <div className="flex flex-1 items-center text-sm text-muted-foreground">
          Words in line
        </div>
        <div className="flex gap-2">
          <div className="relative w-32">
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  className="flex h-8 w-full items-center justify-between text-sm"
                  variant="secondary"
                >
                  <div className="w-full overflow-hidden text-left">
                    <p className="truncate">
                      {
                        OPTIONS_WORDS_IN_LINE.filter(
                          (option) => option.value === data.showObject
                        )[0].label
                      }
                    </p>
                  </div>
                  <ChevronDown className="text-muted-foreground" size={14} />
                </Button>
              </PopoverTrigger>

              <PopoverContent className="z-[300] w-32 p-0">
                {OPTIONS_WORDS_IN_LINE.map((option, index) => (
                  <PopoverClose asChild key={index}>
                    <Button
                      size={"sm"}
                      variant="ghost"
                      className="w-full truncate"
                      onClick={() =>
                        onChange({ type: "showObject", value: option.value })
                      }
                    >
                      {option.label}
                    </Button>
                  </PopoverClose>
                ))}
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </div>

      <div className="flex gap-2">
        <div className="flex flex-1 items-center text-sm text-muted-foreground">
          Position
        </div>
        <div className="flex gap-2">
          <div className="relative w-32">
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  className="flex h-8 w-full items-center justify-between text-sm"
                  variant="secondary"
                >
                  <div className="w-full overflow-hidden text-left">
                    <p className="truncate">Auto</p>
                  </div>
                  <ChevronDown className="text-muted-foreground" size={14} />
                </Button>
              </PopoverTrigger>

              <PopoverContent className="z-[300] w-32 p-0">
                <PopoverClose asChild>
                  <Button
                    size={"sm"}
                    variant="ghost"
                    className="w-full"
                    onClick={() => handlePresetPosition("middle")}
                  >
                    Auto
                  </Button>
                </PopoverClose>
                <PopoverClose asChild>
                  <Button
                    size={"sm"}
                    variant="ghost"
                    className="w-full"
                    onClick={() => handlePresetPosition("up")}
                  >
                    Top
                  </Button>
                </PopoverClose>
                <PopoverClose asChild>
                  <Button
                    size={"sm"}
                    variant="ghost"
                    className="w-full"
                    onClick={() => handlePresetPosition("middle")}
                  >
                    Center
                  </Button>
                </PopoverClose>
                <PopoverClose asChild>
                  <Button
                    size={"sm"}
                    variant="ghost"
                    className="w-full"
                    onClick={() => handlePresetPosition("down")}
                  >
                    Bottom
                  </Button>
                </PopoverClose>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </div>

      <div className="flex gap-2">
        <div className="flex flex-1 items-center text-sm text-muted-foreground">
          Transition
        </div>
        <div className="relative w-32">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                className="flex h-8 w-full items-center justify-between text-sm"
                variant="secondary"
              >
                <div className="w-full overflow-hidden text-left">
                  <p className="truncate">
                    {selectedOptions.length === 0
                      ? "None"
                      : animationOptions.find(
                          (opt) => opt.key === selectedOptions[0]
                        )?.label || "None"}
                  </p>
                </div>
                <ChevronDown className="text-muted-foreground" size={14} />
              </Button>
            </PopoverTrigger>

            <PopoverContent className="w-48 p-2">
              <div className="space-y-1">
                {animationOptions.map((opt) => (
                  <PopoverClose asChild key={opt.key}>
                    <Button
                      variant={
                        selectedOptions.includes(opt.key) ? "default" : "ghost"
                      }
                      size="sm"
                      className="w-full justify-start text-sm"
                      onClick={() => toggleOption(opt.key)}
                    >
                      {opt.label}
                    </Button>
                  </PopoverClose>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </div>
  );
};

export default CaptionWords;
