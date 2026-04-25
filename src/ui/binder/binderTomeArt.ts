import * as THREE from "three";

/** Procedural leather grain (matches `CardBinderEngine` shell) for arbitrary canvas size. */
export function paintBinderLeatherGrain(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const mx = w * 0.5;
  const my = h * 0.5;
  const gr = ctx.createRadialGradient(mx, my, Math.min(w, h) * 0.12, mx, my, Math.max(w, h) * 0.62);
  gr.addColorStop(0, "#5c2e1a");
  gr.addColorStop(0.6, "#3d1d10");
  gr.addColorStop(1, "#230f07");
  ctx.fillStyle = gr;
  ctx.fillRect(0, 0, w, h);
  const speckles = Math.floor(3000 * ((w * h) / (512 * 512)));
  for (let i = 0; i < speckles; i++) {
    ctx.fillStyle = Math.random() < 0.5 ? "#7a4026" : "#1c0a04";
    ctx.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 1.3, 1 + Math.random() * 1.3);
  }
  ctx.strokeStyle = "rgba(20,8,3,.4)";
  ctx.lineWidth = 1;
  const veins = Math.floor(30 * ((w * h) / (512 * 512)));
  for (let i = 0; i < veins; i++) {
    ctx.beginPath();
    let x = Math.random() * w;
    let y = Math.random() * h;
    ctx.moveTo(x, y);
    for (let k = 0; k < 15; k++) {
      x += (Math.random() - 0.5) * 18 * (w / 512);
      y += (Math.random() - 0.5) * 18 * (h / 512);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  const vg = ctx.createRadialGradient(mx, my, Math.min(w, h) * 0.16, mx, my, Math.max(w, h) * 0.72);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, "rgba(12,4,2,0.42)");
  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/**
 * Exterior rear board of the ring-binder block: leather + gold-foil title
 * “Probably” / “ Nothing” (two lines; orientation matches `rearArt` in CardBinderEngine).
 */
export function createTomeRearBoardFaceTexture(spreadW: number, spreadH: number): THREE.CanvasTexture {
  const w = 1024;
  const h = Math.max(320, Math.round((w * spreadH) / spreadW));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /**
   * Vertical flip so the debossed copy reads upright on the rear plane
   * (`rearArt.rotation.y = Math.PI` + Three UV sampling).
   */
  ctx.save();
  ctx.translate(0, h);
  ctx.scale(1, -1);

  paintBinderLeatherGrain(ctx, w, h);

  /* Subtle spine seam — matches the split in the physical block. */
  ctx.strokeStyle = "rgba(6, 2, 1, 0.38)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(w * 0.5, h * 0.07);
  ctx.lineTo(w * 0.5, h * 0.93);
  ctx.stroke();

  const cx = w * 0.5;
  ctx.textBaseline = "middle";

  /** Bright gold foil + rim (reads clearly on dark leather). */
  const drawGoldFoilLine = (
    text: string,
    x: number,
    y: number,
    fontPx: number,
    weight: number,
    align: CanvasTextAlign,
  ): void => {
    let px = Math.round(fontPx);
    ctx.textAlign = align;
    ctx.font = `${weight} ${px}px Georgia, "Palatino Linotype", "Times New Roman", serif`;
    while (px > 22 && ctx.measureText(text).width > w * 0.88) {
      px -= 1;
      ctx.font = `${weight} ${px}px Georgia, "Palatino Linotype", "Times New Roman", serif`;
    }
    const foil = ctx.createLinearGradient(w * 0.08, y - px * 1.1, w * 0.92, y + px * 1.1);
    foil.addColorStop(0, "#8a6a20");
    foil.addColorStop(0.15, "#d4a21a");
    foil.addColorStop(0.32, "#f0c040");
    foil.addColorStop(0.48, "#ffe566");
    foil.addColorStop(0.55, "#fff3b8");
    foil.addColorStop(0.68, "#e8b428");
    foil.addColorStop(0.85, "#b07810");
    foil.addColorStop(1, "#6a4810");
    ctx.lineWidth = Math.max(2.5, px * 0.07);
    ctx.strokeStyle = "rgba(40, 22, 6, 0.42)";
    ctx.strokeText(text, x, y);
    ctx.fillStyle = foil;
    ctx.fillText(text, x, y);
    ctx.lineWidth = Math.max(1, px * 0.028);
    ctx.strokeStyle = "rgba(255, 236, 180, 0.72)";
    ctx.strokeText(text, x, y);
    ctx.fillStyle = "rgba(255, 248, 210, 0.18)";
    ctx.fillText(text, x, y - px * 0.04);
  };

  const lineGap = Math.round(h * 0.1);
  const yTop = h * 0.44;
  const yBot = yTop + lineGap;
  const baseFs = Math.max(44, Math.round(w * 0.068));
  drawGoldFoilLine("Probably", cx, yTop, baseFs, 700, "center");
  /* Slightly right of “Probably” (matches “ Probably /  Nothing” layout). */
  drawGoldFoilLine("Nothing", cx + w * 0.055, yBot, Math.round(baseFs * 0.96), 650, "left");

  const gloss = ctx.createLinearGradient(0, 0, w, h);
  gloss.addColorStop(0, "rgba(255,255,255,0)");
  gloss.addColorStop(0.45, "rgba(255,248,230,0.06)");
  gloss.addColorStop(0.55, "rgba(255,248,230,0.1)");
  gloss.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gloss;
  ctx.fillRect(0, 0, w, h);

  ctx.restore();

  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  /** Canvas is pre-flipped for the rear plane; keep `flipY` false with `rearArt.rotation.y = Math.PI`. */
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

/** Procedural foil + leather cover for the closed grimoire (front face only). */
export function createGrimoireCoverTexture(): THREE.CanvasTexture {
  const w = 768;
  const h = 960;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  const gr = ctx.createRadialGradient(w * 0.45, h * 0.35, w * 0.08, w * 0.5, h * 0.5, w * 0.72);
  gr.addColorStop(0, "#3d2214");
  gr.addColorStop(0.45, "#1f100a");
  gr.addColorStop(1, "#0c0605");
  ctx.fillStyle = gr;
  ctx.fillRect(0, 0, w, h);

  ctx.save();
  ctx.globalAlpha = 0.22;
  for (let i = 0; i < 9000; i++) {
    const x = Math.random() * w;
    const y = Math.random() * h;
    const s = Math.random() * 1.6;
    ctx.fillStyle = Math.random() < 0.5 ? "#6a3d28" : "#0a0504";
    ctx.fillRect(x, y, s, s);
  }
  ctx.restore();

  ctx.strokeStyle = "rgba(212, 175, 95, 0.14)";
  ctx.lineWidth = 1.2;
  const inset = 36;
  ctx.strokeRect(inset, inset, w - inset * 2, h - inset * 2);
  ctx.strokeRect(inset + 10, inset + 10, w - (inset + 10) * 2, h - (inset + 10) * 2);

  ctx.strokeStyle = "rgba(90, 55, 35, 0.35)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(inset + 22, h * 0.22);
  ctx.lineTo(w - inset - 22, h * 0.22);
  ctx.moveTo(inset + 22, h * 0.78);
  ctx.lineTo(w - inset - 22, h * 0.78);
  ctx.stroke();

  const foil = ctx.createLinearGradient(w * 0.2, h * 0.38, w * 0.82, h * 0.62);
  foil.addColorStop(0, "#3a2410");
  foil.addColorStop(0.22, "#e8c56a");
  foil.addColorStop(0.45, "#fff6d2");
  foil.addColorStop(0.55, "#c9a04a");
  foil.addColorStop(0.78, "#8a6020");
  foil.addColorStop(1, "#2a1808");

  ctx.font = "700 52px Georgia, 'Times New Roman', serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  ctx.strokeText("SIGNAL", w / 2, h * 0.42);
  ctx.strokeText("CODEX", w / 2, h * 0.52);
  ctx.fillStyle = foil;
  ctx.fillText("SIGNAL", w / 2, h * 0.42);
  ctx.fillText("CODEX", w / 2, h * 0.52);

  ctx.font = "italic 400 18px Georgia, serif";
  ctx.fillStyle = "rgba(200, 175, 130, 0.45)";
  ctx.strokeStyle = "rgba(0,0,0,0.4)";
  ctx.lineWidth = 1;
  ctx.strokeText("Doctrine · Ring-bound folio", w / 2, h * 0.6);
  ctx.fillText("Doctrine · Ring-bound folio", w / 2, h * 0.6);

  ctx.strokeStyle = "rgba(212, 175, 95, 0.2)";
  ctx.lineWidth = 1;
  for (let k = 0; k < 4; k++) {
    const cx = k % 2 === 0 ? inset + 48 : w - inset - 48;
    const cy = k < 2 ? inset + 48 : h - inset - 48;
    ctx.beginPath();
    ctx.arc(cx, cy, 18, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 10, 0, Math.PI * 2);
    ctx.stroke();
  }

  const gloss = ctx.createLinearGradient(0, 0, w, h);
  gloss.addColorStop(0, "rgba(255,255,255,0)");
  gloss.addColorStop(0.42, "rgba(255,248,230,0.07)");
  gloss.addColorStop(0.5, "rgba(255,248,230,0.12)");
  gloss.addColorStop(0.58, "rgba(255,248,230,0.05)");
  gloss.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gloss;
  ctx.fillRect(0, 0, w, h);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
