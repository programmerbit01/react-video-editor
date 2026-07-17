import { writeFile } from "fs/promises";
import path from "path";

export interface Overlay {
  path: string;
  fromS: number;
  toS: number;
  x: number;
  y: number;
}

/**
 * A text item → ONE overlay PNG, cropped to the text's own box.
 *
 * Text was FF's biggest silent drop: it renders in the player, and the export simply left it
 * out. The machinery to fix that was already here — captions are drawn with @napi-rs/canvas and
 * overlaid as PNGs, because the render box's ffmpeg may have no libass/drawtext to burn text
 * with. Text goes down the same pipe, and is far cheaper: captions need one PNG per word for the
 * karaoke highlight, text needs exactly one.
 *
 * Cropped to the box for the same reason captions are cropped to their band: a full-frame PNG
 * makes every overlay composite the whole 1080p plane, which is what cost 25s and 5.5GB on a
 * dense segment. A title is a few hundred pixels; render those.
 *
 * The player is the reference. Its defaults live in player/styles.ts and are reproduced here —
 * where they disagree, the export is wrong, so keep them in step.
 */
export async function generateTextOverlay(
  textItem: any,
  outW: number,
  outH: number,
  canvasW: number,
  canvasH: number,
  tmpDir: string,
  idx: number
): Promise<Overlay | null> {
  const { createCanvas } = await import("@napi-rs/canvas");

  const d = (textItem.details ?? {}) as Record<string, any>;
  const text = String(d.text || "").trim();
  if (!text) return null;

  // The design is authored at canvasW×canvasH and may be exported at another size.
  const sx = outW / canvasW;
  const sy = outH / canvasH;

  // px, "42px" or "10%" — of the axis it belongs to. The player resolves these through CSS;
  // here we do it by hand, so both spellings have to work.
  const resolve = (v: unknown, axis: number, fallback = 0): number => {
    if (typeof v === "number") return v * (axis / (axis === outW ? canvasW : canvasH));
    const s = String(v ?? "").trim();
    if (!s) return fallback;
    if (s.endsWith("%")) return (parseFloat(s) / 100) * axis;
    const n = parseFloat(s);
    return Number.isFinite(n) ? n * (axis === outW ? sx : sy) : fallback;
  };

  const fontSize = Math.max(8, Math.round(Number(d.fontSize || 16) * sx));
  const family = String(d.fontFamily || "Arial").split(",")[0].trim();
  const weight = String(d.fontWeight || "normal");
  const color = String(d.color || "#000000");
  const align = String(d.textAlign || "left") as "left" | "center" | "right";
  const boxW = Math.max(1, Math.round(resolve(d.width, outW, outW)));
  const left = Math.round(resolve(d.left, outW, 0));
  const top = Math.round(resolve(d.top, outH, 0));
  const pad = Math.max(0, Math.round(Number(d.padding || 0) * sx));

  const fontSpec = `${weight} ${fontSize}px ${family}, sans-serif`;
  const measure = createCanvas(8, 8).getContext("2d");
  measure.font = fontSpec;

  // Wrap inside the box, the way the player's `width` + wordWrap does.
  const lines: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/)) {
    const next = cur ? `${cur} ${word}` : word;
    if (cur && measure.measureText(next).width > boxW - pad * 2) {
      lines.push(cur);
      cur = word;
    } else cur = next;
  }
  if (cur) lines.push(cur);

  const lineH = Math.round(fontSize * 1.35);
  // Room for the shadow (blur 8 + offset 2) and descenders, so nothing clips at the edges.
  const margin = Math.ceil(fontSize * 0.4) + 12;
  const boxH = lines.length * lineH + pad * 2;

  const cropX = Math.max(0, left - margin);
  const cropY = Math.max(0, top - margin);
  const cropW = Math.min(outW - cropX, boxW + margin * 2);
  const cropH = Math.min(outH - cropY, boxH + margin * 2);
  if (cropW <= 0 || cropH <= 0) return null;

  const canvas = createCanvas(cropW, cropH);
  const ctx = canvas.getContext("2d");
  ctx.translate(-cropX, -cropY); // draw in frame coords; the canvas only spans the crop

  const bg = String(d.backgroundColor || "transparent");
  if (bg && bg !== "transparent" && !bg.startsWith("rgba(0,0,0,0)")) {
    ctx.fillStyle = bg;
    ctx.fillRect(left, top, boxW, boxH);
  }

  ctx.font = fontSpec;
  ctx.textBaseline = "alphabetic";
  ctx.shadowColor = "rgba(0,0,0,0.95)";
  ctx.shadowBlur = 8;
  ctx.shadowOffsetX = 2;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = color;

  for (let i = 0; i < lines.length; i++) {
    const w = measure.measureText(lines[i]).width;
    const x =
      align === "center" ? left + (boxW - w) / 2 : align === "right" ? left + boxW - w - pad : left + pad;
    ctx.fillText(lines[i], x, top + pad + (i + 1) * lineH - Math.round(fontSize * 0.28));
  }

  const outPath = path.join(tmpDir, `text_${idx}.png`);
  await writeFile(outPath, await canvas.encode("png"));

  console.log(
    `[FF/text] #${idx} "${text.slice(0, 32)}" ${fontSize}px ${color} · ${lines.length} line(s) · ` +
      `crop ${cropW}×${cropH} at (${cropX},${cropY}) — ${((cropW * cropH) / (outW * outH) * 100).toFixed(1)}% of frame`
  );

  return {
    path: outPath,
    fromS: Number(textItem.display?.from || 0) / 1000,
    toS: Number(textItem.display?.to || 0) / 1000,
    x: cropX,
    y: cropY
  };
}

