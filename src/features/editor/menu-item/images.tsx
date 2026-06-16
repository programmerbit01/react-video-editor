import { dispatch } from "@designcombo/events";
import { generateId } from "@designcombo/timeline";
import Draggable from "@/components/shared/draggable";
import { IImage } from "@designcombo/types";
import React, { useState, useEffect } from "react";
import { useIsDraggingOverTimeline } from "../hooks/is-dragging-over-timeline";
import { ADD_ITEMS } from "@designcombo/state";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Loader2 } from "lucide-react";
import { usePexelsImages } from "@/hooks/use-pexels-images";
import { ImageLoading } from "@/components/ui/image-loading";

export const Images = () => {
  const isDraggingOverTimeline = useIsDraggingOverTimeline();
  const [searchQuery, setSearchQuery] = useState("");

  const {
    images: pexelsImages,
    loading: pexelsLoading,
    error: pexelsError,
    currentPage,
    hasNextPage,
    searchImages,
    loadCuratedImages,
    searchImagesAppend,
    loadCuratedImagesAppend,
    clearImages
  } = usePexelsImages();

  // Load curated images on component mount
  useEffect(() => {
    loadCuratedImages();
  }, [loadCuratedImages]);

  const handleAddImage = (payload: Partial<IImage>) => {
    const id = generateId();
    dispatch(ADD_ITEMS, {
      payload: {
        trackItems: [
          {
            id,
            type: "image",
            display: {
              from: 0,
              to: 5000
            },
            details: {
              src: payload.details?.src
            },
            metadata: {}
          }
        ]
      }
    });
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      await loadCuratedImages();
      return;
    }

    try {
      await searchImages(searchQuery);
    } finally {
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSearch();
    }
  };

  const handleLoadMore = () => {
    if (hasNextPage) {
      if (searchQuery.trim()) {
        searchImagesAppend(searchQuery, currentPage + 1);
      } else {
        loadCuratedImagesAppend(currentPage + 1);
      }
    }
  };

  const handleClearSearch = () => {
    setSearchQuery("");
    clearImages();
    loadCuratedImages();
  };

  // Use Pexels images if available, otherwise fall back to static images
  const displayImages = pexelsImages;

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
      <div className="flex-none flex items-center gap-1.5 px-3 py-2">
        <div className="relative flex-1">
          <Button
            size="sm"
            variant="ghost"
            className="absolute left-1 top-1/2 h-5 w-5 -translate-y-1/2 p-0"
            onClick={handleSearch}
            disabled={pexelsLoading}
          >
            {pexelsLoading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Search className="h-3 w-3" />
            )}
          </Button>
          <Input
            placeholder="Search images..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyPress={handleKeyPress}
            className="h-7 pl-7 text-xs"
          />
        </div>
        {searchQuery && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            onClick={handleClearSearch}
            disabled={pexelsLoading}
          >
            Clear
          </Button>
        )}
      </div>

      {pexelsError && (
        <div className="flex-none px-4 pb-2">
          <div className="text-sm text-red-500 bg-red-50 dark:bg-red-950/20 p-2 rounded">
            {pexelsError}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto overscroll-contain min-h-0 px-4">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(100px,1fr))] gap-2">
          {displayImages.map((image, index) => {
            return (
              <ImageItem
                key={image.id || index}
                image={image}
                shouldDisplayPreview={!isDraggingOverTimeline}
                handleAddImage={handleAddImage}
              />
            );
          })}
        </div>
        {pexelsLoading && <ImageLoading message="Searching for images..." />}
      </div>

      <div className="flex-none border-t border-border/40 px-4 py-2">
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          onClick={handleLoadMore}
          disabled={pexelsLoading || !hasNextPage}
        >
          {pexelsLoading ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Loading...
            </>
          ) : (
            "Load More"
          )}
        </Button>
      </div>
    </div>
  );
};

const ImageItem = ({
  handleAddImage,
  image,
  shouldDisplayPreview
}: {
  handleAddImage: (payload: Partial<IImage>) => void;
  image: Partial<IImage>;
  shouldDisplayPreview: boolean;
}) => {
  const style = React.useMemo(
    () => ({
      backgroundImage: `url(${image.preview})`,
      backgroundSize: "cover",
      width: "80px",
      height: "80px"
    }),
    [image.preview]
  );

  return (
    <Draggable
      data={image}
      renderCustomPreview={<div style={style} />}
      shouldDisplayPreview={shouldDisplayPreview}
    >
      <div
        onClick={() =>
          handleAddImage({
            id: generateId(),
            details: {
              src: image.details?.src
            }
          } as IImage)
        }
        className="flex aspect-square w-full items-center justify-center overflow-hidden bg-background pb-2 cursor-pointer"
      >
        <img
          draggable={false}
          src={image.preview}
          className="h-full w-full rounded-md object-cover"
          alt="Visual content"
        />
      </div>
    </Draggable>
  );
};
