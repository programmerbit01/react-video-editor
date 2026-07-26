import { ScrollArea } from "@/components/ui/scroll-area";
import { IAudio, ITrackItem } from "@designcombo/types";
import Volume from "./common/volume";
import Speed from "./common/speed";
import VolumeEnvelope from "./common/volume-envelope";
import { VolumeKeyframe } from "../utils/volume-envelope";
import React, { useEffect, useState } from "react";
import { dispatch } from "@designcombo/events";
import { EDIT_OBJECT, LAYER_REPLACE } from "@designcombo/state";
import { Button } from "@/components/ui/button";

const BasicAudio = ({
  trackItem,
  type
}: {
  trackItem: ITrackItem & IAudio;
  type?: string;
}) => {
  const showAll = !type;
  const [properties, setProperties] = useState(trackItem);

  useEffect(() => {
    setProperties(trackItem);
  }, [trackItem]);

  const handleChangeVolume = (v: number) => {
    dispatch(EDIT_OBJECT, {
      payload: {
        [trackItem.id]: {
          details: {
            volume: v
          }
        }
      }
    });

    setProperties((prev) => {
      return {
        ...prev,
        details: {
          ...prev.details,
          volume: v
        }
      };
    });
  };

  const handleChangeSpeed = (v: number) => {
    dispatch(EDIT_OBJECT, {
      payload: {
        [trackItem.id]: {
          playbackRate: v
        }
      }
    });

    setProperties((prev) => {
      return {
        ...prev,
        playbackRate: v
      };
    });
  };

  const handleChangeEnvelope = (kf: VolumeKeyframe[]) => {
    dispatch(EDIT_OBJECT, {
      payload: {
        [trackItem.id]: {
          details: {
            volumeKeyframes: kf
          }
        }
      }
    });

    setProperties((prev) => {
      return {
        ...prev,
        details: {
          ...prev.details,
          volumeKeyframes: kf
        } as typeof prev.details
      };
    });
  };

  const components = [
    {
      key: "speed",
      component: (
        <Speed
          value={properties.playbackRate ?? 1}
          onChange={handleChangeSpeed}
        />
      )
    },
    {
      key: "volume",
      component: (
        <Volume
          onChange={(v: number) => handleChangeVolume(v)}
          value={properties.details.volume ?? 100}
        />
      )
    },
    {
      key: "envelope",
      component: (
        <VolumeEnvelope
          seed={trackItem.id}
          value={(properties.details as any).volumeKeyframes}
          onChange={handleChangeEnvelope}
        />
      )
    }
  ];

  return (
    <div className="flex flex-1 flex-col">
      <ScrollArea className="h-full">
        <div className="flex flex-col gap-2 px-4 py-4">
          {components
            .filter((comp) => showAll || comp.key === type)
            .map((comp) => (
              <React.Fragment key={comp.key}>{comp.component}</React.Fragment>
            ))}
        </div>
      </ScrollArea>
    </div>
  );
};

export default BasicAudio;
