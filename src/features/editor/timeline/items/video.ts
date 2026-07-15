import {
  Control,
  Pattern,
  Trimmable,
  TrimmableProps,
  timeMsToUnits,
  unitsToTimeMs
} from "@designcombo/timeline";
import { Filmstrip, FilmstripBacklogOptions } from "../types";
import ThumbnailCache from "../../utils/thumbnail-cache";
import { getThumbBlob, putThumbBlob } from "../../utils/thumbnail-store";
import { IDisplay, IMetadata, ITrim } from "@designcombo/types";
import {
  calculateOffscreenSegments,
  calculateThumbnailSegmentLayout
} from "../../utils/filmstrip";
import { createMediaControls } from "../controls";
import { SECONDARY_FONT } from "../../constants/constants";
import { PlaybackState } from "../../utils/playback-state";
import { TranscriptOverlayStore } from "../../utils/transcript-overlay-store";
import { AnimationOverlayStore } from "../../utils/animation-overlay-store";
import useTranscriptGuideStore from "../../store/use-transcript-guide-store";

const TRANSCRIPT_ZONE_H = 16;

// Type declaration for MP4Clip to avoid SSR issues
type MP4ClipType = any;

// Canvas-based thumbnail extractor — fallback when OPFS (MP4Clip) is unavailable (HTTP context).
// Works with proxied URLs that return Access-Control-Allow-Origin: *.
class CanvasVideoClip {
  private src: string;
  private video: HTMLVideoElement | null = null;
  private ready: Promise<void>;

  constructor(src: string) {
    this.src = src;
    this.ready = this.init();
  }

  private init(): Promise<void> {
    return new Promise((resolve) => {
      const v = document.createElement("video");
      v.crossOrigin = "anonymous";
      // metadata (not auto): don't download the WHOLE file per clip — with many clips
      // that saturates the network and some time out → black. Seeking still range-fetches.
      v.preload = "metadata";
      v.muted = true;
      v.playsInline = true;
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        this.video = v;
        resolve();
      };
      const fail = () => {
        if (resolved) return;
        resolved = true;
        resolve();
      };
      const timer = setTimeout(fail, 10000);
      const finish = () => {
        clearTimeout(timer);
        done();
      };
      v.onloadeddata = done;
      v.onloadedmetadata = finish;
      v.oncanplay = finish;
      v.onerror = fail;
      v.src = this.src;
      v.load();
    });
  }

  async thumbnailsList(
    width: number,
    { timestamps }: { timestamps: number[] }
  ): Promise<{ ts: number; img: Blob }[]> {
    await this.ready;
    if (!this.video) return [];

    const v = this.video;
    const aspect = v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 9 / 16;
    const h = Math.max(1, Math.round(width / aspect));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    const results: { ts: number; img: Blob }[] = [];

    for (const ts of timestamps) {
      // Persistent cache first — a hit skips the (slow) seek+decode entirely, so a
      // reloaded/re-opened project fills its filmstrip straight from IndexedDB.
      const cached = await getThumbBlob(this.src, width, ts);
      if (cached) { results.push({ ts, img: cached }); continue; }

      const secs = ts / 1e6;
      // Always seek explicitly — skipping when currentTime matches causes black frames
      // because the decoder may not have produced the frame yet (especially at t=0 via proxy)
      await new Promise<void>((res) => {
        const timeout = setTimeout(res, 6000);
        const onSeeked = () => { clearTimeout(timeout); v.removeEventListener("seeked", onSeeked); res(); };
        v.addEventListener("seeked", onSeeked);
        v.currentTime = secs;
      });
      try {
        await new Promise<void>((res) => requestAnimationFrame(() => res()));
        ctx.drawImage(v, 0, 0, width, h);
        const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.7));
        if (blob) {
          results.push({ ts, img: blob });
          void putThumbBlob(this.src, width, ts, blob); // persist for next load
        }
      } catch { /* canvas tainted — skip */ }
    }

    // Some remote MP4s don't support fast/random seeking reliably.
    // If extraction failed, provide at least one reusable frame.
    if (results.length === 0 && timestamps.length > 0) {
      try {
        ctx.drawImage(v, 0, 0, width, h);
        const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.7));
        if (blob) {
          return timestamps.map((ts) => ({ ts, img: blob }));
        }
      } catch { /* ignore */ }
    }

    return results;
  }
}

const EMPTY_FILMSTRIP: Filmstrip = {
  offset: 0,
  startTime: 0,
  thumbnailsCount: 0,
  widthOnScreen: 0
};

interface VideoProps extends TrimmableProps {
  aspectRatio: number;
  trim: ITrim;
  duration: number;
  src: string;
  metadata?: Partial<IMetadata> & {
    previewUrl?: string;
  };
}
class Video extends Trimmable {
  static type = "Video";
  public clip?: MP4ClipType | null;
  declare id: string;
  public resourceId = "";
  declare tScale: number;
  public isSelected = false;
  declare display: IDisplay;
  declare trim: ITrim;
  declare playbackRate: number;
  public hasSrc = true;
  declare duration: number;
  public prevDuration: number;
  public itemType = "video";
  public metadata?: Partial<IMetadata>;
  declare src: string;

  public aspectRatio = 1;
  public scrollLeft = 0;
  public filmstripBacklogOptions?: FilmstripBacklogOptions;
  public thumbnailsPerSegment = 0;
  public segmentSize = 0;

  public offscreenSegments = 0;
  public thumbnailWidth = 0;
  public thumbnailHeight = 40;
  public thumbnailsList: { url: string; ts: number }[] = [];
  public isFetchingThumbnails = false;
  public thumbnailCache = new ThumbnailCache();

  public currentFilmstrip: Filmstrip = EMPTY_FILMSTRIP;
  public nextFilmstrip: Filmstrip = { ...EMPTY_FILMSTRIP, segmentIndex: 0 };
  public loadingFilmstrip: Filmstrip = EMPTY_FILMSTRIP;

  private offscreenCanvas: OffscreenCanvas | null = null;
  private offscreenCtx: OffscreenCanvasRenderingContext2D | null = null;

  private isDirty = true;
  private lastHadTranscript = false;

  private fallbackSegmentIndex = 0;
  private fallbackSegmentsCount = 0;
  private previewUrl = "";

  static createControls(): { controls: Record<string, Control> } {
    return { controls: createMediaControls() };
  }

  constructor(props: VideoProps) {
    super(props);
    this.id = props.id;
    this.tScale = props.tScale;
    this.objectCaching = false;
    this.rx = 4;
    this.ry = 4;
    this.display = props.display;
    this.trim = props.trim;
    this.duration = props.duration;
    this.prevDuration = props.duration;
    this.fill = "#27272a";
    this.borderOpacityWhenMoving = 1;
    this.metadata = props.metadata;

    this.aspectRatio = props.aspectRatio;

    this.src = props.src;
    this.strokeWidth = 0;

    this.transparentCorners = false;
    this.hasBorders = false;

    this.previewUrl = props.metadata?.previewUrl ?? "";
    this.initOffscreenCanvas();
    this.initialize();
  }

  private initOffscreenCanvas() {
    if (!this.offscreenCanvas) {
      this.offscreenCanvas = new OffscreenCanvas(this.width, this.height);
      this.offscreenCtx = this.offscreenCanvas.getContext("2d");
    }

    // Resize if dimensions changed
    if (
      this.offscreenCanvas.width !== this.width ||
      this.offscreenCanvas.height !== this.height
    ) {
      this.offscreenCanvas.width = this.width;
      this.offscreenCanvas.height = this.height;
      this.isDirty = true;
    }
  }

  public initDimensions() {
    this.thumbnailWidth = this.thumbnailHeight * this.aspectRatio;

    const segmentOptions = calculateThumbnailSegmentLayout(this.thumbnailWidth);
    this.thumbnailsPerSegment = segmentOptions.thumbnailsPerSegment;
    this.segmentSize = segmentOptions.segmentSize;
  }

  public async initialize() {
    await this.loadFallbackThumbnail();

    this.initDimensions();
    this.onScrollChange({ scrollLeft: 0 });

    this.canvas?.requestRenderAll();

    this.createFallbackPattern();
    await this.prepareAssets();

    this.onScrollChange({ scrollLeft: 0 });
  }

  public async prepareAssets() {
    this.clip = new CanvasVideoClip(this.src);
  }

  private calculateFilmstripDimensions({
    segmentIndex,
    widthOnScreen
  }: {
    segmentIndex: number;
    widthOnScreen: number;
  }) {
    const filmstripOffset = segmentIndex * this.segmentSize;
    const shouldUseLeftBacklog = segmentIndex > 0;
    const leftBacklogSize = shouldUseLeftBacklog ? this.segmentSize : 0;

    const totalWidth = timeMsToUnits(
      this.duration,
      this.tScale,
      this.playbackRate
    );

    const rightRemainingSize =
      totalWidth - widthOnScreen - leftBacklogSize - filmstripOffset;
    const rightBacklogSize = Math.min(this.segmentSize, rightRemainingSize);

    const filmstripStartTime = unitsToTimeMs(filmstripOffset, this.tScale);
    const filmstrimpThumbnailsCount =
      1 +
      Math.round(
        (widthOnScreen + leftBacklogSize + rightBacklogSize) /
          this.thumbnailWidth
      );

    return {
      filmstripOffset,
      leftBacklogSize,
      rightBacklogSize,
      filmstripStartTime,
      filmstrimpThumbnailsCount
    };
  }

  // load fallback thumbnail, resize it and cache it
  private async loadFallbackThumbnail() {
    const fallbackThumbnail = this.previewUrl;
    if (!fallbackThumbnail) {
      await this.loadFallbackFromVideoFrame();
      return;
    }

    return new Promise<void>((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      const needsCacheBust =
        fallbackThumbnail.startsWith("http://") ||
        fallbackThumbnail.startsWith("https://") ||
        fallbackThumbnail.startsWith("/");
      img.src = needsCacheBust ? `${fallbackThumbnail}${fallbackThumbnail.includes("?") ? "&" : "?"}t=${Date.now()}` : fallbackThumbnail;
      img.onload = () => {
        // Create a temporary canvas to resize the image
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve();

        // Calculate new width maintaining aspect ratio
        const aspectRatio = img.width / img.height;
        const targetHeight = 40;
        const targetWidth = Math.round(targetHeight * aspectRatio);
        // Set canvas size and draw resized image
        canvas.height = targetHeight;
        canvas.width = targetWidth;
        ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

        // Create new image from resized canvas
        const resizedImg = new Image();
        resizedImg.src = canvas.toDataURL();
        // Update aspect ratio and cache the resized image
        this.aspectRatio = aspectRatio;
        this.thumbnailWidth = targetWidth;
        this.thumbnailCache.setThumbnail("fallback", resizedImg);
        resolve();
      };
      img.onerror = () => resolve();
    });
  }

  private async loadFallbackFromVideoFrame() {
    return new Promise<void>((resolve) => {
      const v = document.createElement("video");
      v.crossOrigin = "anonymous";
      v.preload = "metadata";
      v.muted = true;
      v.playsInline = true;
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
      const timer = setTimeout(finish, 8000);
      const capture = () => {
        if (done) return;
        try {
          const w = v.videoWidth || 0;
          const h = v.videoHeight || 0;
          if (!w || !h) return finish();
          const aspectRatio = w / h;
          const targetHeight = 40;
          const targetWidth = Math.max(1, Math.round(targetHeight * aspectRatio));
          const canvas = document.createElement("canvas");
          canvas.width = targetWidth;
          canvas.height = targetHeight;
          const ctx = canvas.getContext("2d");
          if (!ctx) return finish();
          ctx.drawImage(v, 0, 0, targetWidth, targetHeight);
          const img = new Image();
          img.onload = () => {
            this.aspectRatio = aspectRatio;
            this.thumbnailWidth = targetWidth;
            this.thumbnailCache.setThumbnail("fallback", img);
            finish();
          };
          img.onerror = finish;
          img.src = canvas.toDataURL("image/jpeg", 0.7);
        } catch {
          finish();
        }
      };
      // With preload=metadata, onloadeddata may not fire on its own — seek to force a
      // frame decode, then capture on `seeked` (falls back to loadeddata if it fires).
      v.onloadedmetadata = () => {
        const t = Number.isFinite(v.duration) && v.duration > 0.2 ? 0.1 : 0;
        try { v.currentTime = t; } catch { capture(); }
      };
      v.onseeked = capture;
      v.onloadeddata = () => { if (v.readyState >= 2) capture(); };
      v.onerror = finish;
      v.src = this.src;
      v.load();
    });
  }

  private generateTimestamps(startTime: number, count: number): number[] {
    const timePerThumbnail = unitsToTimeMs(
      this.thumbnailWidth,
      this.tScale,
      this.playbackRate
    );

    return Array.from({ length: count }, (_, i) => {
      const timeInFilmstripe = startTime + i * timePerThumbnail;
      return Math.ceil(timeInFilmstripe / 1000);
    });
  }

  private createFallbackPattern() {
    const canvas = this.canvas;
    if (!canvas) return;

    const canvasWidth = canvas.width;
    const maxPatternSize = 12000;
    const fallbackSource = this.thumbnailCache.getThumbnail("fallback");

    if (!fallbackSource) return;

    // Compute the total width and number of segments needed
    const totalWidthNeeded = Math.min(canvasWidth * 20, maxPatternSize);
    const segmentsRequired = Math.ceil(totalWidthNeeded / this.segmentSize);
    this.fallbackSegmentsCount = segmentsRequired;
    const patternWidth = segmentsRequired * this.segmentSize;

    // Setup canvas dimensions
    const offCanvas = document.createElement("canvas");
    offCanvas.height = this.thumbnailHeight;
    offCanvas.width = patternWidth;

    const context = offCanvas.getContext("2d");
    if (!context) return;
    const thumbnailsTotal = segmentsRequired * this.thumbnailsPerSegment;

    // Draw the fallback image across the entirety of the canvas horizontally
    for (let i = 0; i < thumbnailsTotal; i++) {
      const x = i * this.thumbnailWidth;
      context.drawImage(
        fallbackSource,
        x,
        0,
        this.thumbnailWidth,
        this.thumbnailHeight
      );
    }

    // Create the pattern and apply it
    const fillPattern = new Pattern({
      source: offCanvas,
      repeat: "no-repeat",
      offsetX: 0
    });

    this.set("fill", fillPattern);
    this.canvas?.requestRenderAll();
  }
  public async loadAndRenderThumbnails() {
    if (this.isFetchingThumbnails || !this.clip) return;
    // set segmentDrawn to segmentToDraw
    this.loadingFilmstrip = { ...this.nextFilmstrip };
    this.isFetchingThumbnails = true;

    // Calculate dimensions and offsets
    const { startTime, thumbnailsCount } = this.loadingFilmstrip;

    // Generate required timestamps
    const timestamps = this.generateTimestamps(startTime, thumbnailsCount);

    // Match and prepare thumbnails
    const thumbnailsArr = await this.clip.thumbnailsList(this.thumbnailWidth, {
      timestamps: timestamps.map((timestamp) => timestamp * 1e6)
    });

    const updatedThumbnails = thumbnailsArr.map(
      (thumbnail: { ts: number; img: Blob }) => {
        return {
          ts: Math.round(thumbnail.ts / 1e6),
          img: thumbnail.img
        };
      }
    );

    // Load all thumbnails in parallel
    await this.loadThumbnailBatch(updatedThumbnails);

    this.isDirty = true; // Mark as dirty after preparing new thumbnails
    // this.isFallbackDirty = true;
    this.isFetchingThumbnails = false;

    this.currentFilmstrip = { ...this.loadingFilmstrip };

    requestAnimationFrame(() => {
      this.canvas?.requestRenderAll();
    });
  }

  private async loadThumbnailBatch(thumbnails: { ts: number; img: Blob }[]) {
    const loadPromises = thumbnails.map(async (thumbnail) => {
      if (this.thumbnailCache.getThumbnail(thumbnail.ts)) return;

      return new Promise<void>((resolve) => {
        const img = new Image();
        img.src = URL.createObjectURL(thumbnail.img);
        img.onload = () => {
          URL.revokeObjectURL(img.src); // Clean up the blob URL after image loads
          this.thumbnailCache.setThumbnail(thumbnail.ts, img);
          resolve();
        };
      });
    });

    await Promise.all(loadPromises);
  }

  public _render(ctx: CanvasRenderingContext2D) {
    super._render(ctx);

    // Re-clip thumbnails when transcript becomes available or disappears
    const hasTranscript = Boolean(TranscriptOverlayStore[this.id]?.length);
    if (hasTranscript !== this.lastHadTranscript) {
      this.lastHadTranscript = hasTranscript;
      this.isDirty = true;
    }

    ctx.save();
    ctx.translate(-this.width / 2, -this.height / 2);

    // Clip the area to prevent drawing outside
    ctx.beginPath();
    ctx.rect(0, 0, this.width, this.height);
    ctx.clip();

    this.renderToOffscreen();
    if (Math.floor(this.width) === 0) return;
    if (!this.offscreenCanvas) return;
    ctx.drawImage(this.offscreenCanvas, 0, 0);

    ctx.restore();
    this.drawTranscriptZone(ctx);
    this.drawAnimationIndicators(ctx);
    this.updateSelected(ctx);
  }

  private drawTranscriptZone(ctx: CanvasRenderingContext2D) {
    const segments = TranscriptOverlayStore[this.id];
    if (!segments?.length) return;

    const clipDurMs = this.display.to - this.display.from;
    if (clipDurMs <= 0 || this.width <= 0) return;

    const pxPerMs = this.width / clipDurMs;
    const trimFromMs = this.trim?.from ?? 0;
    const sourceMs = PlaybackState.currentMs - this.display.from + trimFromMs;

    ctx.save();
    ctx.translate(-this.width / 2, -this.height / 2);
    ctx.beginPath();
    ctx.rect(0, 0, this.width, this.height);
    ctx.clip();

    const zoneY = this.height - TRANSCRIPT_ZONE_H;

    // Full-width solid bar — covers anything the thumbnail may have drawn in this area
    ctx.fillStyle = "rgba(8, 4, 20, 0.93)";
    ctx.beginPath();
    ctx.roundRect(0, zoneY, this.width, TRANSCRIPT_ZONE_H, [0, 0, this.rx, this.rx]);
    ctx.fill();

    // Top separator
    ctx.fillStyle = "rgba(100, 70, 200, 0.5)";
    ctx.fillRect(0, zoneY, this.width, 1);

    // Words positioned at actual timeline x (aligns with playhead over thumbnails)
    ctx.font = `500 11px ${SECONDARY_FONT}`;
    ctx.textBaseline = "middle";
    const textY = zoneY + TRANSCRIPT_ZONE_H / 2;

    ctx.save();
    ctx.beginPath();
    ctx.rect(2, zoneY + 1, this.width - 4, TRANSCRIPT_ZONE_H - 1);
    ctx.clip();

    for (const seg of segments) {
      for (const word of seg.words) {
        const wordTimeFromClipStart = word.startMs - trimFromMs;
        if (wordTimeFromClipStart < 0) continue;
        const wordX = wordTimeFromClipStart * pxPerMs;
        if (wordX >= this.width) break;

        const isActive = sourceMs >= word.startMs && sourceMs < word.endMs;
        const isPast = sourceMs >= word.endMs;
        ctx.fillStyle = isActive
          ? "#F5E7BE"
          : isPast
            ? "rgba(255,255,255,0.6)"
            : "rgba(255,255,255,0.7)";

        ctx.fillText(word.word, wordX, textY);
      }
    }

    const selectedGuide = useTranscriptGuideStore.getState().selectedGuide;
    if (selectedGuide?.itemId === this.id) {
      const startX = Math.max(
        0,
        Math.min(this.width, (selectedGuide.startMs - this.display.from) * pxPerMs)
      );
      const endX = Math.max(
        startX + 1,
        Math.min(this.width, (selectedGuide.endMs - this.display.from) * pxPerMs)
      );

      ctx.save();
      ctx.fillStyle = "rgba(139, 92, 246, 0.10)";
      ctx.fillRect(startX, zoneY, Math.max(2, endX - startX), TRANSCRIPT_ZONE_H);
      ctx.strokeStyle = "rgba(168, 85, 247, 0.92)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(startX, zoneY - 6);
      ctx.lineTo(startX, this.height);
      ctx.stroke();

      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = "rgba(245, 231, 190, 0.9)";
      ctx.beginPath();
      ctx.moveTo(endX, zoneY - 8);
      ctx.lineTo(endX, this.height);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = "rgba(245, 231, 190, 0.95)";
      ctx.beginPath();
      ctx.roundRect(endX - 3, zoneY - 10, 6, 8, 3);
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();
    ctx.restore();
  }

  public setDuration(duration: number) {
    this.duration = duration;
    this.prevDuration = duration;
  }

  public async setSrc(src: string) {
    super.setSrc(src);
    this.clip = null;
    await this.initialize();
    await this.prepareAssets();
    this.thumbnailCache.clearCacheButFallback();
    this.onScale();
  }
  public onResizeSnap() {
    this.renderToOffscreen(true);
  }
  public onResize() {
    this.renderToOffscreen(true);
  }

  public renderToOffscreen(force?: boolean) {
    if (!this.offscreenCtx) return;
    if (!this.isDirty && !force) return;

    if (!this.offscreenCanvas) return;
    this.offscreenCanvas.width = this.width;
    const ctx = this.offscreenCtx;
    const { startTime, offset, thumbnailsCount } = this.currentFilmstrip;
    const thumbnailWidth = this.thumbnailWidth;
    const thumbnailHeight = this.thumbnailHeight;
    // Calculate the offset caused by the trimming
    const trimFromSize = timeMsToUnits(
      this.trim.from,
      this.tScale,
      this.playbackRate
    );

    let timeInFilmstripe = startTime;
    const timePerThumbnail = unitsToTimeMs(
      thumbnailWidth,
      this.tScale,
      this.playbackRate || 1
    );

    // Clear the offscreen canvas
    ctx.clearRect(0, 0, this.width, this.height);

    // When transcript data exists, reserve the bottom TRANSCRIPT_ZONE_H pixels for text
    const hasTranscript = Boolean(TranscriptOverlayStore[this.id]?.length);
    const clipH = hasTranscript
      ? Math.max(10, this.height - TRANSCRIPT_ZONE_H)
      : this.height;

    ctx.beginPath();
    if (hasTranscript && clipH < this.height) {
      // Rounded top corners only; bottom is flat (text zone takes over)
      ctx.roundRect(0, 0, this.width, clipH, [this.rx, this.rx, 0, 0]);
    } else {
      ctx.roundRect(0, 0, this.width, this.height, this.rx);
    }
    ctx.clip();

    // Draw thumbnails
    for (let i = 0; i < thumbnailsCount; i++) {
      let img = this.thumbnailCache.getThumbnail(
        Math.ceil(timeInFilmstripe / 1000)
      );

      if (!img) {
        img = this.thumbnailCache.getThumbnail("fallback");
      }

      if (img?.complete) {
        const xPosition = i * thumbnailWidth + offset - trimFromSize;

        ctx.drawImage(img, xPosition, 0, thumbnailWidth, thumbnailHeight);
      }
      timeInFilmstripe += timePerThumbnail;
    }

    this.isDirty = false;
  }

  private drawAnimationIndicators(ctx: CanvasRenderingContext2D) {
    const overlay = AnimationOverlayStore[this.id];
    if (!overlay) return;

    const clipDurMs = this.display.to - this.display.from;
    if (clipDurMs <= 0 || this.width <= 0) return;

    const pxPerMs = this.width / clipDurMs;
    const T = 18; // triangle size in px

    ctx.save();
    ctx.translate(-this.width / 2, -this.height / 2);
    ctx.beginPath();
    ctx.rect(0, 0, this.width, this.height);
    ctx.clip();

    if (overlay.hasIn && overlay.inDurMs > 0) {
      const stripeW = Math.max(8, Math.min(overlay.inDurMs * pxPerMs, this.width * 0.5));
      // Gradient zone
      const grad = ctx.createLinearGradient(0, 0, stripeW, 0);
      grad.addColorStop(0, "rgba(255,255,255,0.70)");
      grad.addColorStop(0.4, "rgba(255,255,255,0.30)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, stripeW, this.height);
      // Solid left edge line
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.fillRect(0, 0, 3, this.height);
      // Corner triangle (top-left, pointing into the clip)
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
      // Gradient zone
      const grad = ctx.createLinearGradient(x, 0, this.width, 0);
      grad.addColorStop(0, "rgba(255,255,255,0)");
      grad.addColorStop(0.6, "rgba(255,255,255,0.30)");
      grad.addColorStop(1, "rgba(255,255,255,0.70)");
      ctx.fillStyle = grad;
      ctx.fillRect(x, 0, stripeW, this.height);
      // Solid right edge line
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.fillRect(this.width - 3, 0, 3, this.height);
      // Corner triangle (top-right, pointing into the clip)
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

  public drawTextIdentity(ctx: CanvasRenderingContext2D) {
    const iconPath = new Path2D(
      "M16.5625 0.925L12.5 3.275V0.625L11.875 0H0.625L0 0.625V9.375L0.625 10H11.875L12.5 9.375V6.875L16.5625 9.2125L17.5 8.625V1.475L16.5625 0.925ZM11.25 8.75H1.25V1.25H11.25V8.75ZM16.25 7.5L12.5 5.375V4.725L16.25 2.5V7.5Z"
    );
    ctx.save();
    ctx.translate(-this.width / 2, -this.height / 2);
    ctx.translate(0, 14);
    ctx.font = `400 12px ${SECONDARY_FONT}`;
    ctx.fillStyle = "#f4f4f5";
    ctx.textAlign = "left";
    ctx.clip();
    ctx.fillText("Video", 36, 10);

    ctx.translate(8, 1);

    ctx.fillStyle = "#f4f4f5";
    ctx.fill(iconPath);
    ctx.restore();
  }

  public setSelected(selected: boolean) {
    this.isSelected = selected;
    this.set({ dirty: true });
  }

  public updateSelected(ctx: CanvasRenderingContext2D) {
    const borderColor = this.isSelected
      ? "rgba(255, 255, 255,1.0)"
      : "rgba(255, 255, 255,0.05)";
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

  public calulateWidthOnScreen() {
    const canvasEl = document.getElementById("designcombo-timeline-canvas");
    const canvasWidth = canvasEl?.clientWidth;
    const scrollLeft = this.scrollLeft;
    if (!canvasWidth) return 0;
    const timelineWidth = canvasWidth;
    const cutFromBottomEdge = Math.max(
      timelineWidth - (this.width + this.left + scrollLeft),
      0
    );
    const visibleHeight = Math.min(
      timelineWidth - this.left - scrollLeft,
      timelineWidth
    );

    return Math.max(visibleHeight - cutFromBottomEdge, 0);
  }

  // Calculate the width that is not visible on the screen measured from the left
  public calculateOffscreenWidth({ scrollLeft }: { scrollLeft: number }) {
    const offscreenWidth = Math.min(this.left + scrollLeft, 0);

    return Math.abs(offscreenWidth);
  }

  public onScrollChange({
    scrollLeft,
    force
  }: {
    scrollLeft: number;
    force?: boolean;
  }) {
    const offscreenWidth = this.calculateOffscreenWidth({ scrollLeft });
    const trimFromSize = timeMsToUnits(
      this.trim.from,
      this.tScale,
      this.playbackRate
    );

    const offscreenSegments = calculateOffscreenSegments(
      offscreenWidth,
      trimFromSize,
      this.segmentSize
    );

    this.offscreenSegments = offscreenSegments;

    // calculate start segment to draw
    const segmentToDraw = offscreenSegments;

    if (this.currentFilmstrip.segmentIndex === segmentToDraw) {
      return false;
    }

    if (segmentToDraw !== this.fallbackSegmentIndex) {
      const fillPattern = this.fill as Pattern;
      if (fillPattern instanceof Pattern) {
        fillPattern.offsetX =
          this.segmentSize *
          (segmentToDraw - Math.floor(this.fallbackSegmentsCount / 2));
      }

      this.fallbackSegmentIndex = segmentToDraw;
    }
    if (!this.isFetchingThumbnails || force) {
      this.scrollLeft = scrollLeft;
      const widthOnScreen = this.calulateWidthOnScreen();
      // With these lines:
      const { filmstripOffset, filmstripStartTime, filmstrimpThumbnailsCount } =
        this.calculateFilmstripDimensions({
          widthOnScreen: this.calulateWidthOnScreen(),
          segmentIndex: segmentToDraw
        });

      this.nextFilmstrip = {
        segmentIndex: segmentToDraw,
        offset: filmstripOffset,
        startTime: filmstripStartTime,
        thumbnailsCount: filmstrimpThumbnailsCount,
        widthOnScreen
      };

      this.loadAndRenderThumbnails();
    }
  }
  public onScale() {
    this.currentFilmstrip = { ...EMPTY_FILMSTRIP };
    this.nextFilmstrip = { ...EMPTY_FILMSTRIP, segmentIndex: 0 };
    this.loadingFilmstrip = { ...EMPTY_FILMSTRIP };
    this.onScrollChange({ scrollLeft: this.scrollLeft, force: true });
  }
}

export default Video;
