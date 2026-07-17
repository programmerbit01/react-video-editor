import {
  Resizable,
  ResizableProps,
  Pattern,
  util,
  Control
} from "@designcombo/timeline";
import { createResizeControls } from "../controls";
import { AnimationOverlayStore } from "../../utils/animation-overlay-store";

interface ImageProps extends ResizableProps {
  src: string;
  metadata?: {
    previewUrl?: string;
  };
}

class Image extends Resizable {
  static type = "Image";
  public src: string;
  public hasSrc = true;

  static createControls(): { controls: Record<string, Control> } {
    return { controls: createResizeControls() };
  }

  constructor(props: ImageProps) {
    super(props);
    this.id = props.id;
    this.src = props.metadata?.previewUrl || props.src;
    this.display = props.display;
    this.tScale = props.tScale;
    this.loadImage();
  }

  public _render(ctx: CanvasRenderingContext2D) {
    super._render(ctx);
    this.drawAnimationIndicators(ctx);
    this.updateSelected(ctx);
  }

  private drawAnimationIndicators(ctx: CanvasRenderingContext2D) {
    const overlay = AnimationOverlayStore[this.id];
    if (!overlay) return;

    const clipDurMs = this.display.to - this.display.from;
    if (clipDurMs <= 0 || this.width <= 0) return;

    const pxPerMs = this.width / clipDurMs;
    const T = 18;

    ctx.save();
    ctx.translate(-this.width / 2, -this.height / 2);
    ctx.beginPath();
    ctx.rect(0, 0, this.width, this.height);
    ctx.clip();

    if (overlay.hasIn && overlay.inDurMs > 0) {
      const stripeW = Math.max(8, Math.min(overlay.inDurMs * pxPerMs, this.width * 0.5));
      const grad = ctx.createLinearGradient(0, 0, stripeW, 0);
      grad.addColorStop(0, "rgba(255,255,255,0.70)");
      grad.addColorStop(0.4, "rgba(255,255,255,0.30)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, stripeW, this.height);
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.fillRect(0, 0, 3, this.height);
      ctx.fillStyle = "rgba(255,255,255,1)";
      ctx.beginPath();
      ctx.moveTo(3, 3);
      ctx.lineTo(3 + T, 3);
      ctx.lineTo(3, 3 + T);
      ctx.closePath();
      ctx.fill();
    }

    if (overlay.hasOut && overlay.outDurMs > 0) {
      const stripeW = Math.max(8, Math.min(overlay.outDurMs * pxPerMs, this.width * 0.5));
      const x = this.width - stripeW;
      const grad = ctx.createLinearGradient(x, 0, this.width, 0);
      grad.addColorStop(0, "rgba(255,255,255,0)");
      grad.addColorStop(0.6, "rgba(255,255,255,0.30)");
      grad.addColorStop(1, "rgba(255,255,255,0.70)");
      ctx.fillStyle = grad;
      ctx.fillRect(x, 0, stripeW, this.height);
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.fillRect(this.width - 3, 0, 3, this.height);
      ctx.fillStyle = "rgba(255,255,255,1)";
      ctx.beginPath();
      ctx.moveTo(this.width - 3, 3);
      ctx.lineTo(this.width - 3 - T, 3);
      ctx.lineTo(this.width - 3, 3 + T);
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  }

  public loadImage() {
    util.loadImage(this.src).then((img) => {
      const imgHeight = img.height;
      const rectHeight = this.height;
      const scaleY = rectHeight / imgHeight;
      const pattern = new Pattern({
        source: img,
        repeat: "repeat-x",
        patternTransform: [scaleY, 0, 0, scaleY, 0, 0]
      });
      this.set("fill", pattern);
      this.canvas?.requestRenderAll();
    });
  }

  public setSrc(src: string) {
    this.src = src;
    this.loadImage();
    this.canvas?.requestRenderAll();
  }

  public updateSelected(ctx: CanvasRenderingContext2D) {
    const borderColor = this.isSelected
      ? "rgba(255, 255, 255,1.0)"
      : "rgba(255, 255, 255,0.1)";
    const borderWidth = 2;
    const innerRadius = 4;

    ctx.save();
    ctx.fillStyle = borderColor;

    // Create a path for the outer rectangle (no radius)
    ctx.beginPath();
    ctx.rect(-this.width / 2, -this.height / 2, this.width, this.height);

    // Create a path for the inner rectangle with rounded corners (the hole)
    ctx.roundRect(
      -this.width / 2 + borderWidth,
      -this.height / 2 + borderWidth,
      this.width - borderWidth * 2,
      this.height - borderWidth * 2,
      innerRadius
    );

    // Use even-odd fill rule to create the border effect
    ctx.fill("evenodd");
    ctx.restore();
  }
}

export default Image;
