import { Control, Resizable, ResizableProps } from "@designcombo/timeline";
import { IDisplay } from "@designcombo/types";
import { createResizeControls } from "../controls";
import { SECONDARY_FONT } from "../../constants/constants";

interface GraphicProps extends ResizableProps {
  tScale: number;
  display: IDisplay;
  name?: string;
  type?: string;
}

/**
 * Timeline bar for the data-graphic item types — barchart, linechart, statcard, bulletlist,
 * lottie.
 *
 * The player has rendered these for a while (see the SequenceItem registry), and the AI
 * generator emits them, but the timeline had no class registered for any of them. Adding one
 * to a project threw `fabric: No class registered for Barchart` out of Timeline.addTrackItem —
 * uncaught, and with no ErrorBoundary above the editor tree that takes down the whole app.
 *
 * They're overlays with no waveform or filmstrip to show, so a labelled bar is the whole job;
 * one class serves all of them and is registered under each type name in timeline.tsx.
 */
class Graphic extends Resizable {
  static type = "Graphic";
  declare id: string;
  declare label: string;

  static createControls(): { controls: Record<string, Control> } {
    return { controls: createResizeControls() };
  }

  constructor(props: GraphicProps) {
    super(props);
    this.id = props.id;
    this.fill = "#2a1f3d";
    this.borderColor = "transparent";
    this.stroke = "transparent";
    this.label = String(props.name || props.type || "graphic");
  }

  public _render(ctx: CanvasRenderingContext2D) {
    super._render(ctx);
    this.drawLabel(ctx);
    this.updateSelected(ctx);
  }

  public drawLabel(ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.translate(-this.width / 2, -this.height / 2);
    ctx.translate(0, 8);
    ctx.font = `400 12px ${SECONDARY_FONT}`;
    ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
    ctx.textAlign = "left";
    ctx.clip();

    // Three ascending bars — reads as "chart" at 12px without shipping an icon per type.
    ctx.translate(8, 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
    ctx.fillRect(0, 7, 3, 5);
    ctx.fillRect(5, 4, 3, 8);
    ctx.fillRect(10, 0, 3, 12);
    ctx.translate(-8, -2);

    ctx.fillText(this.label, 28, 12);
    ctx.restore();
  }

  public updateSelected(ctx: CanvasRenderingContext2D) {
    const borderColor = this.isSelected
      ? "rgba(255, 255, 255,1.0)"
      : "rgba(255, 255, 255,0.05)";
    const borderWidth = 2;
    const innerRadius = 4;

    ctx.save();
    ctx.fillStyle = borderColor;
    ctx.beginPath();
    ctx.rect(-this.width / 2, -this.height / 2, this.width, this.height);
    ctx.roundRect(
      -this.width / 2 + borderWidth,
      -this.height / 2 + borderWidth,
      this.width - borderWidth * 2,
      this.height - borderWidth * 2,
      innerRadius
    );
    ctx.fill("evenodd");
    ctx.restore();
  }
}

export default Graphic;
