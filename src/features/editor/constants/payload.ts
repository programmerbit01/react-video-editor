import { generateId } from "@designcombo/timeline";
import { Easing } from "remotion";
import { DEFAULT_FONT } from "./font";

// Documentary-style lower third: bottom-left, white text on a translucent
// backing, subtle shadow, with a ~0.3s fade in/out. Edit the text in place.
export const LOWER_THIRD_ADD_PAYLOAD = {
  id: generateId(),
  display: {
    from: 0,
    to: 4000
  },
  type: "text",
  details: {
    text: "Name / Date / Fact",
    fontSize: 42,
    width: 760,
    fontUrl: DEFAULT_FONT.url,
    fontFamily: DEFAULT_FONT.postScriptName,
    color: "#ffffff",
    textAlign: "left",
    wordWrap: "break-word",
    top: "880px",
    left: "80px",
    backgroundColor: "rgba(0,0,0,0.55)",
    padding: "12px 18px",
    borderWidth: 0,
    borderColor: "#000000",
    boxShadow: {
      color: "rgba(0,0,0,0.85)",
      x: 0,
      y: 2,
      blur: 6
    }
  },
  animations: {
    in: {
      name: "fadeIn",
      composition: [
        {
          property: "opacity",
          from: 0,
          to: 1,
          durationInFrames: 9,
          easing: "linear",
          ease: Easing.linear
        }
      ]
    },
    out: {
      name: "fadeOut",
      composition: [
        {
          property: "opacity",
          from: 1,
          to: 0,
          durationInFrames: 9,
          easing: "linear",
          ease: Easing.linear
        }
      ]
    }
  }
};

export const TEXT_ADD_PAYLOAD = {
  id: generateId(),
  display: {
    from: 0,
    to: 5000
  },
  type: "text",
  details: {
    text: "Heading and some body",
    fontSize: 120,
    width: 600,
    fontUrl: DEFAULT_FONT.url,
    fontFamily: DEFAULT_FONT.postScriptName,
    color: "#ffffff",
    wordWrap: "break-word",
    textAlign: "center",
    borderWidth: 0,
    borderColor: "#000000",
    boxShadow: {
      color: "#ffffff",
      x: 0,
      y: 0,
      blur: 0
    }
  }
};
