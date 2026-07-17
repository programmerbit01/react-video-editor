import React from "react";
import {
  IAudio,
  ICaption,
  IHillAudioBars,
  IIllustration,
  IImage,
  ITrackItem,
  ILinealAudioBars,
  IProgressBar,
  IProgressFrame,
  IRadialAudioBars,
  IShape,
  IText,
  IVideo,
  IWaveAudioBars
} from "@designcombo/types";
import {
  Audio,
  Caption,
  HillAudioBars,
  Illustration,
  Image,
  LinealAudioBars,
  ProgressBar,
  ProgressFrame,
  RadialAudioBars,
  Shape,
  Text,
  Video,
  WaveAudioBars,
  BarChart,
  LineChart,
  StatCard,
  BulletList,
  LottieItem
} from "./items";
import { SequenceItemOptions } from "./base-sequence";

export const SequenceItem: Record<
  string,
  (item: ITrackItem, options: SequenceItemOptions) => React.JSX.Element
> = {
  text: (item, options) => Text({ item: item as IText, options }),
  caption: (item, options) => Caption({ item: item as ICaption, options }),
  shape: (item, options) => Shape({ item: item as IShape, options }),
  video: (item, options) => Video({ item: item as IVideo, options }),
  audio: (item, options) => Audio({ item: item as IAudio, options }),
  illustration: (item, options) =>
    Illustration({ item: item as IIllustration, options }),
  progressBar: (item, options) =>
    ProgressBar({ item: item as IProgressBar, options }),
  linealAudioBars: (item, options) =>
    LinealAudioBars({ item: item as ILinealAudioBars, options }),
  waveAudioBars: (item, options) =>
    WaveAudioBars({ item: item as IWaveAudioBars, options }),
  hillAudioBars: (item, options) =>
    HillAudioBars({ item: item as IHillAudioBars, options }),
  progressFrame: (item, options) =>
    ProgressFrame({ item: item as IProgressFrame, options }),
  radialAudioBars: (item, options) =>
    RadialAudioBars({ item: item as IRadialAudioBars, options }),
  barchart: (item, options) => BarChart({ item, options }),
  linechart: (item, options) => LineChart({ item, options }),
  statcard: (item, options) => StatCard({ item, options }),
  bulletlist: (item, options) => BulletList({ item, options }),
  lottie: (item, options) => <LottieItem item={item} options={options} />,
  // An image is an image. Charts and Lottie used to arrive here wearing type "image" with the
  // truth in metadata.graphicType, and this branch undid the disguise — a dodge for a timeline
  // crash that item-types.ts has since made impossible. They now say what they are and land in
  // the entries above, so there is nothing left to undo.
  image: (item, options) => Image({ item: item as IImage, options })
};
