import { useState } from "react";
import { Film, ImageIcon, Music, Landmark } from "lucide-react";
import { cn } from "@/lib/utils";
import { Videos } from "./videos";
import { Images } from "./images";
import { Audios } from "./audios";
import { Archival } from "./archival";

type StockTab = "video" | "images" | "archival" | "sound";

const TABS: { id: StockTab; icon: typeof Film; label: string }[] = [
  { id: "video",    icon: Film,      label: "Video"    },
  { id: "images",   icon: ImageIcon, label: "Images"   },
  { id: "archival", icon: Landmark,  label: "Archival" },
  { id: "sound",    icon: Music,     label: "Sound"    },
];

export const Stock = () => {
  const [tab, setTab] = useState<StockTab>("video");

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
      {/* Compact sub-tab bar */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-border/50 flex-shrink-0">
        {TABS.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            title={label}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
              tab === id
                ? "bg-white/10 text-white"
                : "text-muted-foreground hover:bg-white/5 hover:text-white"
            )}
          >
            <Icon size={13} />
            <span>{label}</span>
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
        {tab === "video"    && <Videos />}
        {tab === "images"   && <Images />}
        {tab === "archival" && <Archival />}
        {tab === "sound"    && <Audios />}
      </div>
    </div>
  );
};
