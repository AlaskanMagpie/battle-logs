import * as THREE from "three";
import { TCG_FULL_CARD_H, TCG_FULL_CARD_W } from "../tcgCardPrint";

/** Match `binderPanelPixelSize()` / sleeve composite aspect (no import cycle with `CardBinderEngine`). */
function panelPixelSize(): { w: number; h: number } {
  return { w: TCG_FULL_CARD_W, h: TCG_FULL_CARD_H };
}

/**
 * One shared texture for every binder card back (lightweight vs per-card raster).
 * Shield plate + stacked "Battle Logs" title; reads clearly when pages turn.
 */
export function createBinderCardBackTexture(): THREE.CanvasTexture {
  const { w: W, h: H } = panelPixelSize();
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d");
  if (!ctx) {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  const bg = "#121b2a";
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const cx = W * 0.5;
  const top = H * 0.14;
  const shW = W * 0.52;
  const shH = H * 0.62;
  const shL = cx - shW / 2;

  ctx.beginPath();
  ctx.moveTo(cx, top + shH * 0.08);
  ctx.lineTo(shL + shW * 0.92, top + shH * 0.12);
  ctx.lineTo(shL + shW, top + shH * 0.22);
  ctx.lineTo(shL + shW * 0.96, top + shH * 0.78);
  ctx.lineTo(cx, top + shH);
  ctx.lineTo(shL + shW * 0.04, top + shH * 0.78);
  ctx.lineTo(shL, top + shH * 0.22);
  ctx.lineTo(shL + shW * 0.08, top + shH * 0.12);
  ctx.closePath();
  ctx.fillStyle = "#354d72";
  ctx.fill();
  ctx.strokeStyle = "rgba(150, 195, 255, 0.62)";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = "#eef4ff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${Math.round(H * 0.09)}px system-ui, Segoe UI, sans-serif`;
  ctx.fillText("BATTLE", cx, top + shH * 0.42);
  ctx.font = `650 ${Math.round(H * 0.085)}px system-ui, Segoe UI, sans-serif`;
  ctx.fillText("LOGS", cx, top + shH * 0.58);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}
