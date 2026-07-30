import { ScrollArea } from "@/components/ui/scroll-area";
import useDataState from "../store/use-data-state";
import { loadFonts } from "../utils/fonts";
import { editSelected } from "./edit-selected";
import React, { useEffect, useState } from "react";
import { IBoxShadow, IText, ITrackItem } from "@designcombo/types";
import Outline from "./common/outline";
import Shadow from "./common/shadow";
import { TextControls } from "./common/text";
import { ICompactFont, IFont } from "../interfaces/editor";
import { DEFAULT_FONT } from "../constants/font";
import { PresetText } from "./common/preset-text";
import { Animations } from "./common/animations";

interface ITextControlProps {
  color: string;
  colorDisplay: string;
  backgroundColor: string;
  fontSize: number;
  fontSizeDisplay: string;
  fontFamily: string;
  fontFamilyDisplay: string;
  opacityDisplay: string;
  textAlign: string;
  textDecoration: string;
  borderWidth: number;
  borderColor: string;
  opacity: number;
  boxShadow: IBoxShadow;
}

const getStyleNameFromFontName = (fontName: string) => {
  const fontFamilyEnd = fontName.lastIndexOf("-");
  const styleName = fontName
    .substring(fontFamilyEnd + 1)
    .replace("Italic", " Italic");
  return styleName;
};

const BasicText = ({
  trackItem,
  type
}: {
  trackItem: ITrackItem & IText;
  type?: string;
}) => {
  const showAll = !type;
  const [properties, setProperties] = useState<ITextControlProps>({
    color: "#000000",
    colorDisplay: "#000000",
    backgroundColor: "transparent",
    fontSize: 12,
    fontSizeDisplay: "12px",
    fontFamily: "Open Sans",
    fontFamilyDisplay: "Open Sans",
    opacity: 1,
    opacityDisplay: "100%",
    textAlign: "left",
    textDecoration: "none",
    borderWidth: 0,
    borderColor: "#000000",
    boxShadow: {
      color: "#000000",
      x: 0,
      y: 0,
      blur: 0
    }
  });

  const [selectedFont, setSelectedFont] = useState<ICompactFont>({
    family: "Open Sans",
    styles: [],
    default: DEFAULT_FONT,
    name: "Regular"
  });
  const { compactFonts, fonts } = useDataState();

  useEffect(() => {
    const fontFamily =
      trackItem.details.fontFamily || DEFAULT_FONT.postScriptName;
    const currentFont = fonts.find(
      (font) => font.postScriptName === fontFamily
    );

    if (!currentFont) return;

    const selectedFont = compactFonts.find(
      (font) => font.family === currentFont?.family
    );

    if (!selectedFont) return;

    setSelectedFont({
      ...selectedFont,
      name: getStyleNameFromFontName(currentFont.postScriptName)
    });

    setProperties({
      color: trackItem.details.color || "#ffffff",
      colorDisplay: trackItem.details.color || "#ffffff",
      backgroundColor: trackItem.details.backgroundColor || "transparent",
      fontSize: trackItem.details.fontSize || 62,
      fontSizeDisplay: `${trackItem.details.fontSize || 62}px`,
      fontFamily: selectedFont?.family || "Open Sans",
      fontFamilyDisplay: selectedFont?.family || "Open Sans",
      opacity: trackItem.details.opacity || 1,
      opacityDisplay: `${trackItem.details.opacity.toString() || "100"}%`,
      textAlign: trackItem.details.textAlign || "left",
      textDecoration: trackItem.details.textDecoration || "none",
      borderWidth: trackItem.details.borderWidth || 0,
      borderColor: trackItem.details.borderColor || "#000000",
      boxShadow: trackItem.details.boxShadow || {
        color: "#000000",
        x: 0,
        y: 0,
        blur: 0
      }
    });
  }, [trackItem.id]);

  const handleChangeFontStyle = async (font: IFont) => {
    const fontName = font.postScriptName;
    const fontUrl = font.url;
    const styleName = getStyleNameFromFontName(fontName);
    await loadFonts([
      {
        name: fontName,
        url: fontUrl
      }
    ]);
    setSelectedFont({ ...selectedFont, name: styleName });
    // Every text control fans out to all selected clips (whole-row = all). Single select = 1 clip.
    editSelected({ details: { fontFamily: fontName, fontUrl } });
  };

  const onChangeBorderWidth = (v: number) => {
    editSelected({ details: { borderWidth: v } });
    setProperties((prev) => ({ ...prev, borderWidth: v }) as ITextControlProps);
  };

  const onChangeBorderColor = (v: string) => {
    editSelected({ details: { borderColor: v } });
    setProperties((prev) => ({ ...prev, borderColor: v }) as ITextControlProps);
  };

  const handleChangeOpacity = (v: number) => {
    editSelected({ details: { opacity: v } });
    setProperties((prev) => ({ ...prev, opacity: v }) as ITextControlProps);
  };

  const onChangeBoxShadow = (boxShadow: IBoxShadow) => {
    editSelected({ details: { boxShadow } });
    setProperties((prev) => ({ ...prev, boxShadow }) as ITextControlProps);
  };

  const onChangeFontSize = (v: number) => {
    editSelected({ details: { fontSize: v } });
    setProperties((prev) => ({ ...prev, fontSize: v }) as ITextControlProps);
  };

  const onChangeFontFamily = async (font: ICompactFont) => {
    const fontName = font.default.postScriptName;
    const fontUrl = font.default.url;

    await loadFonts([
      {
        name: fontName,
        url: fontUrl
      }
    ]);
    setSelectedFont({ ...font, name: getStyleNameFromFontName(fontName) });
    setProperties({
      ...properties,
      fontFamily: font.default.family,
      fontFamilyDisplay: font.default.family
    });

    editSelected({ details: { fontFamily: fontName, fontUrl } });
  };

  const handleColorChange = (color: string) => {
    setProperties((prev) => ({ ...prev, color }) as ITextControlProps);
    editSelected({ details: { color } });
  };

  const handleBackgroundChange = (color: string) => {
    setProperties((prev) => ({ ...prev, backgroundColor: color }) as ITextControlProps);
    editSelected({ details: { backgroundColor: color } });
  };

  const onChangeTextAlign = (v: string) => {
    setProperties((prev) => ({ ...prev, textAlign: v }) as ITextControlProps);
    editSelected({ details: { textAlign: v } });
  };

  const onChangeTextDecoration = (v: string) => {
    setProperties({
      ...properties,
      textDecoration: v
    });
    editSelected({ details: { textDecoration: v } });
  };

  const components = [
    {
      key: "textPreset",
      component: <PresetText trackItem={trackItem} properties={properties} />
    },
    {
      key: "textControls",
      component: (
        <TextControls
          trackItem={trackItem}
          properties={properties}
          selectedFont={selectedFont}
          onChangeFontFamily={onChangeFontFamily}
          handleChangeFontStyle={handleChangeFontStyle}
          onChangeFontSize={onChangeFontSize}
          handleColorChange={handleColorChange}
          handleBackgroundChange={handleBackgroundChange}
          onChangeTextAlign={onChangeTextAlign}
          onChangeTextDecoration={onChangeTextDecoration}
          handleChangeOpacity={handleChangeOpacity}
        />
      )
    },
    {
      key: "animations",
      component: <Animations trackItem={trackItem} properties={properties} />
    },
    {
      key: "fontStroke",
      component: (
        <Outline
          label="Font stroke"
          onChageBorderWidth={(v: number) => onChangeBorderWidth(v)}
          onChangeBorderColor={(v: string) => onChangeBorderColor(v)}
          valueBorderWidth={properties.borderWidth as number}
          valueBorderColor={properties.borderColor as string}
        />
      )
    },
    {
      key: "fontShadow",
      component: (
        <Shadow
          label="Font shadow"
          onChange={(v: IBoxShadow) => onChangeBoxShadow(v)}
          value={
            properties.boxShadow ?? {
              color: "#000000",
              x: 0,
              y: 0,
              blur: 0
            }
          }
        />
      )
    }
  ];

  return (
    <div className="flex lg:h-[calc(100vh-84px)] flex-1 flex-col overflow-hidden min-h-[340px]">
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

export default BasicText;
