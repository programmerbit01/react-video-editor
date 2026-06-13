import { JSX } from "react";
import {
  SlideDirection,
  circle,
  clockWipe,
  fade,
  flip,
  linearTiming,
  rectangle,
  slide,
  slidingDoors,
  star,
  wipe
} from "./transitions";
import { TransitionSeries } from "./transitions";

interface TransitionOptions {
  width: number;
  height: number;
  durationInFrames: number;
  id: string;
  direction?: SlideDirection;
}

const asTransitionPresentation = <T,>(presentation: T) => presentation as any;

export const Transitions: Record<
  string,
  (options: TransitionOptions) => JSX.Element
> = {
  none: ({ id }: TransitionOptions) => (
    <TransitionSeries.Transition
      key={id}
      presentation={asTransitionPresentation(fade())}
      timing={linearTiming({ durationInFrames: 1 })}
    />
  ),
  fade: ({ durationInFrames, id }: TransitionOptions) => (
    <TransitionSeries.Transition
      key={id}
      presentation={asTransitionPresentation(fade())}
      timing={linearTiming({ durationInFrames })}
    />
  ),
  slide: ({ durationInFrames, id, direction }: TransitionOptions) => (
    <TransitionSeries.Transition
      key={id}
      presentation={asTransitionPresentation(slide({ direction: direction }))}
      timing={linearTiming({ durationInFrames })}
    />
  ),
  wipe: ({ durationInFrames, id, direction }: TransitionOptions) => (
    <TransitionSeries.Transition
      key={id}
      presentation={asTransitionPresentation(wipe({ direction: direction }))}
      timing={linearTiming({ durationInFrames })}
    />
  ),
  flip: ({ durationInFrames, id }: TransitionOptions) => (
    <TransitionSeries.Transition
      key={id}
      presentation={asTransitionPresentation(flip())}
      timing={linearTiming({ durationInFrames })}
    />
  ),

  clockWipe: ({ width, height, durationInFrames, id }: TransitionOptions) => (
    <TransitionSeries.Transition
      key={id}
      presentation={asTransitionPresentation(clockWipe({ width, height }))}
      timing={linearTiming({ durationInFrames })}
    />
  ),
  star: ({ width, height, durationInFrames, id }: TransitionOptions) => (
    <TransitionSeries.Transition
      key={id}
      presentation={asTransitionPresentation(star({ width, height }))}
      timing={linearTiming({ durationInFrames })}
    />
  ),
  circle: ({ width, height, durationInFrames, id }: TransitionOptions) => {
    return (
      <TransitionSeries.Transition
        key={id}
        presentation={asTransitionPresentation(circle({ width, height }))}
        timing={linearTiming({ durationInFrames })}
      />
    );
  },
  rectangle: ({ width, height, durationInFrames, id }: TransitionOptions) => (
    <TransitionSeries.Transition
      key={id}
      presentation={asTransitionPresentation(rectangle({ width, height }))}
      timing={linearTiming({ durationInFrames })}
    />
  ),
  slidingDoors: ({
    width,
    height,
    durationInFrames,
    id
  }: TransitionOptions) => (
    <TransitionSeries.Transition
      key={id}
      presentation={asTransitionPresentation(slidingDoors({ width, height }))}
      timing={linearTiming({ durationInFrames })}
    />
  )
};
