import { commandEffectRadius } from "../../game/catalog";
import type { CommandCatalogEntry } from "../../game/types";

/** Mirrors `spellAoeScale` in doctrineCard.ts for card viz footprint. */
function aoeVisualScale(e: CommandCatalogEntry): number {
  const rWorld = commandEffectRadius(e);
  if (rWorld != null) {
    const t = Math.min(1, Math.max(0, (rWorld - 5) / 10));
    return 0.84 + t * 0.36;
  }
  const fx = e.effect.type;
  if (fx === "aoe_shatter_chain") return 0.78;
  if (fx === "aoe_tactics_field") return 0.72;
  if (fx === "aoe_line_damage") return 0.88;
  if (fx === "noop") return 0.55;
  return 0.65;
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function strokeCircle(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  lw: number,
  stroke: string,
): void {
  ctx.save();
  ctx.lineWidth = lw;
  ctx.strokeStyle = stroke;
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(0.5, r), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/**
 * Animated spell “portrait” for binder textures — procedural analogue of `.spell-card-viz` (hud.css).
 */
export function drawSpellBinderHero(
  ctx: CanvasRenderingContext2D,
  cmd: CommandCatalogEntry,
  x: number,
  y: number,
  w: number,
  h: number,
  hue: number,
  tSec: number,
): void {
  const fx = cmd.effect.type;
  const aoe = aoeVisualScale(cmd);
  const cx = x + w * 0.5;
  const cy = y + h * 0.46;
  const rMax = Math.min(w, h) * 0.54 * aoe;

  ctx.save();
  roundRectPath(ctx, x, y, w, h, 4);
  ctx.clip();

  const vign = ctx.createRadialGradient(cx, cy, rMax * 0.06, cx, cy, rMax * 1.08);
  vign.addColorStop(0, `hsla(${hue}, 38%, 20%, 1)`);
  vign.addColorStop(0.5, `hsla(${hue + 22}, 30%, 11%, 1)`);
  vign.addColorStop(1, "#05070c");
  ctx.fillStyle = vign;
  ctx.fillRect(x, y, w, h);

  const pulseOuter = 0.52 + 0.36 * Math.sin(tSec * ((Math.PI * 2) / 1.55));
  const pulseInner = 0.38 + 0.34 * Math.sin(tSec * ((Math.PI * 2) / 1.35) + 0.4);
  const breath = 0.94 + 0.06 * Math.sin(tSec * 4.2);

  if (fx === "aoe_damage") {
    strokeCircle(
      ctx,
      cx,
      cy,
      rMax * 0.54 * breath,
      2,
      `rgba(255, 110, 62, ${0.32 + 0.48 * pulseOuter})`,
    );
    strokeCircle(
      ctx,
      cx,
      cy,
      rMax * 0.26 * breath,
      2,
      `rgba(255, 215, 122, ${0.22 + 0.42 * pulseInner})`,
    );
    for (let i = 0; i < 10; i++) {
      const ang = (i / 10) * Math.PI * 2 + tSec * 0.42;
      const rr = rMax * (0.2 + 0.52 * (0.5 + 0.5 * Math.sin(tSec * 3.1 + i * 0.65)));
      const px = cx + Math.cos(ang) * rr;
      const py = cy + Math.sin(ang) * rr * 0.9;
      const tw = 0.55 + 0.45 * Math.sin(tSec * 5.5 + i);
      ctx.fillStyle = `rgba(255, ${170 + Math.floor(50 * tw)}, 95, ${0.32 + 0.48 * tw})`;
      ctx.beginPath();
      ctx.arc(px, py, Math.max(1.2, rMax * 0.026), 0, Math.PI * 2);
      ctx.fill();
    }
    const u = (tSec % 0.85) / 0.85;
    const coreS = 0.88 + 0.2 * Math.sin(u * Math.PI);
    const coreA = 0.85 * (0.75 + 0.25 * Math.sin(u * Math.PI * 2));
    const gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, rMax * 0.22 * coreS);
    gr.addColorStop(0, `rgba(255, 240, 200, ${0.55 * coreA})`);
    gr.addColorStop(0.45, `rgba(255, 120, 50, ${0.35 * coreA})`);
    gr.addColorStop(1, "rgba(255, 60, 20, 0)");
    ctx.fillStyle = gr;
    ctx.beginPath();
    ctx.arc(cx, cy, rMax * 0.22 * coreS, 0, Math.PI * 2);
    ctx.fill();
    const haloT = (tSec % 1.1) / 1.1;
    const haloR = rMax * (0.19 + 0.19 * haloT);
    const haloA = 0.55 * (1 - haloT);
    strokeCircle(ctx, cx, cy, haloR, 2, `rgba(255, 170, 80, ${0.2 + 0.35 * haloA})`);
  } else if (fx === "aoe_tactics_field") {
    strokeCircle(
      ctx,
      cx,
      cy,
      rMax * 0.52 * breath,
      2,
      `rgba(106, 225, 255, ${0.28 + 0.35 * pulseOuter})`,
    );
    strokeCircle(
      ctx,
      cx,
      cy,
      rMax * 0.27 * breath,
      2,
      `rgba(255, 217, 104, ${0.22 + 0.32 * pulseInner})`,
    );
    const rot = tSec * ((Math.PI * 2) / 2.6);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.strokeStyle = `rgba(106, 225, 255, ${0.45 + 0.25 * Math.sin(tSec * 3)})`;
    ctx.lineWidth = 2;
    const hs = rMax * 0.34;
    ctx.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 - Math.PI / 2;
      const px = Math.cos(a) * hs;
      const py = Math.sin(a) * hs;
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = "rgba(106, 225, 255, 0.1)";
    ctx.fill();
    ctx.restore();
  } else if (fx === "aoe_line_damage") {
    const { length: lineLen, halfWidth: hw } = cmd.effect;
    const span = Math.min(rMax * 1.05, (lineLen / 42) * rMax * 1.1);
    const thick = Math.max(2, (hw / 3.5) * rMax * 0.07);
    const ang = -0.15 + 0.04 * Math.sin(tSec * 2.8);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    const wobble = 0.08 * Math.sin(tSec * 4.2);
    ctx.strokeStyle = `rgba(255, 110, 210, ${0.35 + 0.35 * pulseOuter})`;
    ctx.lineWidth = thick + 3;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-span * 0.52, wobble);
    ctx.lineTo(span * 0.52, -wobble);
    ctx.stroke();
    ctx.strokeStyle = `rgba(160, 255, 210, ${0.42 + 0.38 * pulseInner})`;
    ctx.lineWidth = thick;
    ctx.beginPath();
    ctx.moveTo(-span * 0.52, wobble);
    ctx.lineTo(span * 0.52, -wobble);
    ctx.stroke();
    ctx.restore();
  } else if (fx === "aoe_shatter_chain") {
    strokeCircle(
      ctx,
      cx,
      cy,
      rMax * 0.5 * breath,
      2,
      `rgba(143, 214, 255, ${0.35 + 0.45 * pulseOuter})`,
    );
    strokeCircle(
      ctx,
      cx,
      cy,
      rMax * 0.26 * breath,
      2,
      `rgba(200, 179, 255, ${0.28 + 0.4 * pulseInner})`,
    );
    const shockA = (tSec % 0.85) / 0.85;
    const ra = rMax * (0.12 + 0.55 * shockA);
    strokeCircle(
      ctx,
      cx,
      cy,
      ra,
      2,
      `rgba(143, 214, 255, ${0.75 * (1 - shockA)})`,
    );
    const shockB = ((tSec + 0.1) % 0.85) / 0.85;
    const rb = rMax * (0.11 + 0.5 * shockB);
    strokeCircle(
      ctx,
      cx,
      cy,
      rb,
      2,
      `rgba(200, 179, 255, ${0.65 * (1 - shockB)})`,
    );
    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * Math.PI * 2;
      const cp = 0.35 + 0.5 * Math.sin(tSec * 5 + i);
      ctx.strokeStyle = `rgba(170, 210, 255, ${0.2 + 0.55 * cp})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * rMax * 0.12, cy + Math.sin(ang) * rMax * 0.12);
      ctx.lineTo(cx + Math.cos(ang) * rMax * 0.48, cy + Math.sin(ang) * rMax * 0.48);
      ctx.stroke();
    }
  } else {
    const np = 0.35 + 0.35 * Math.sin(tSec * ((Math.PI * 2) / 1.4));
    const ns = 0.9 + 0.15 * Math.sin(tSec * ((Math.PI * 2) / 1.4) + 0.3);
    strokeCircle(
      ctx,
      cx,
      cy,
      rMax * 0.2 * ns,
      2,
      `rgba(180, 170, 220, ${0.35 + 0.45 * np})`,
    );
  }

  ctx.restore();
}
