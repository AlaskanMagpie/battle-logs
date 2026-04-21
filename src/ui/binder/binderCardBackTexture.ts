import * as THREE from "three";

/** Same geometry as `CardBinderEngine` panels (kept local to avoid import cycle). */
function panelPixelSize(): { w: number; h: number } {
  const pageWidth = 2.1;
  const pageHeight = 2.85;
  const seamGap = 0.04;
  const panelTexW = 400;
  const colW = (pageWidth - seamGap * 2) / 3;
  const rowH = (pageHeight - seamGap * 2) / 3;
  const h = Math.round((panelTexW * rowH) / colW);
  return { w: panelTexW, h };
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

  const bg = "#0e1522";
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
  ctx.fillStyle = "#2a3d5c";
  ctx.fill();
  ctx.strokeStyle = "rgba(120, 170, 230, 0.55)";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = "#dce8f8";
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
