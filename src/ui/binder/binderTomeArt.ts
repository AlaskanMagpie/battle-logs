import * as THREE from "three";

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
