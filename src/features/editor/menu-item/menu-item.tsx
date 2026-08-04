import useLayoutStore from "../store/use-layout-store";
import { Transitions } from "./transitions";
import { Texts } from "./texts";
import { Audios } from "./audios";
import { Elements } from "./elements";
import { Images } from "./images";
import { Videos } from "./videos";
import { Captions } from "../captions/panel";
import { VoiceOver } from "./voice-over";
import { useIsLargeScreen } from "@/hooks/use-media-query";
import { Uploads } from "./uploads";
import { AiVoice } from "./ai-voice";
import { SFX } from "./sfx";
import { VappMedia } from "./vapp-media";
import { Stock } from "./stock";
import { WebSearch } from "./web-search";
import { Graphics } from "./graphics";
import { MotionGraphics } from "./motion-graphics";

const ActiveMenuItem = () => {
  const { activeMenuItem } = useLayoutStore();

  if (activeMenuItem === "transitions") {
    return <Transitions />;
  }
  if (activeMenuItem === "texts") {
    return <Texts />;
  }
  if (activeMenuItem === "shapes") {
    return <Elements />;
  }
  if (activeMenuItem === "stock") {
    return <Stock />;
  }
  if (activeMenuItem === "web") {
    return <WebSearch />;
  }
  if (activeMenuItem === "videos") {
    return <Videos />;
  }
  if (activeMenuItem === "captions") {
    return <Captions />;
  }

  if (activeMenuItem === "audios") {
    return <Audios />;
  }

  if (activeMenuItem === "images") {
    return <Images />;
  }

  if (activeMenuItem === "voiceOver") {
    return <VoiceOver />;
  }
  if (activeMenuItem === "elements") {
    return <Elements />;
  }
  if (activeMenuItem === "uploads") {
    return <Uploads />;
  }

  if (activeMenuItem === "ai-voice") {
    return <AiVoice />;
  }

  if (activeMenuItem === "sfx") {
    return <SFX />;
  }

  if (activeMenuItem === "vapp") {
    return <VappMedia />;
  }

  if (activeMenuItem === "graphics") {
    return <Graphics />;
  }

  if (activeMenuItem === "motionGraphics") {
    return <MotionGraphics />;
  }

  return null;
};

export const MenuItem = () => {
  return (
    <div className="w-full flex flex-1 flex-col min-h-0 overflow-hidden">
      <ActiveMenuItem />
    </div>
  );
};
