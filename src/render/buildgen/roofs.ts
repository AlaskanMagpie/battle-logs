/**
 * Roof generators ported from buildin-s. Returns flat arrays of meshes that the
 * caller adds to the building group.
 */
import * as THREE from "three";
import { bbox, edgesOf, scalePoly, type Poly, type Pt } from "./footprints";
import { extrudeMass, makeBox, triGeo } from "./geometry";
import { clamp, rrange, TAU, type Rng } from "./rng";
import type { Mats, Style } from "./styles";

export function buildRoof(
  kind: string,
  points: Poly,
  C: Pt,
  y0: number,
  style: Style,
  mats: Mats,
  rng: Rng,
): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  const bb = bbox(points);
  const span = Math.min(bb.w, bb.d);
  const apexH = clamp(span * 0.5, 3, 16);
  if (kind === "flat") {
    for (const e of edgesOf(points)) {
      const pm = makeBox(e.len + 0.4, 1.1, 0.5, mats.roof);
      pm.position.set(e.mx, y0 + 0.55, e.mz);
      pm.rotation.y = Math.atan2(e.nx, e.nz);
      pm.castShadow = true;
      out.push(pm);
    }
    const cap = new THREE.Mesh(extrudeMass(points, 0.3), mats.roofDark);
    cap.position.y = y0;
    out.push(cap);
  } else if (kind === "hip" || kind === "spire") {
    const h = kind === "spire" ? clamp(span * 1.4, 16, 60) : apexH * (style.tile ? 1.0 : 1.1);
    const ov = style.tile ? 1.6 : 0.0;
    const pts = ov > 0 ? scalePoly(points, 1 + ov / Math.max(span, 1), C) : points;
    const pos: number[] = [],
      apex = [C[0], y0 + h, C[1]];
    for (const e of edgesOf(pts)) pos.push(e.a[0], y0, e.a[1], e.b[0], y0, e.b[1], apex[0]!, apex[1]!, apex[2]!);
    const m = new THREE.Mesh(triGeo(pos), style.tile ? mats.tile : mats.roof);
    m.castShadow = true;
    out.push(m);
    if (style.tile) {
      const cap = new THREE.Mesh(extrudeMass(pts, 0.2), mats.tile);
      cap.position.y = y0 - 0.1;
      out.push(cap);
    }
  } else if (kind === "gable") {
    if (points.length === 4) {
      const h = clamp(span * 0.55, 3, 12);
      const x0 = bb.minx,
        x1 = bb.maxx,
        z0 = bb.minz,
        z1 = bb.maxz,
        cx = (x0 + x1) / 2,
        cz = (z0 + z1) / 2,
        pos: number[] = [];
      if (bb.w >= bb.d) {
        const R0x = x0,
          R1x = x1,
          Ry = y0 + h,
          Rz = cz;
        pos.push(x0, y0, z0, R0x, Ry, Rz, x1, y0, z0);
        pos.push(R0x, Ry, Rz, R1x, Ry, Rz, x1, y0, z0);
        pos.push(x1, y0, z1, R1x, Ry, Rz, x0, y0, z1);
        pos.push(R1x, Ry, Rz, R0x, Ry, Rz, x0, y0, z1);
        pos.push(x0, y0, z0, x0, y0, z1, R0x, Ry, Rz);
        pos.push(x1, y0, z1, x1, y0, z0, R1x, Ry, Rz);
      } else {
        const Rx = cx,
          Ry = y0 + h,
          Za = z0,
          Zb = z1;
        pos.push(x0, y0, z0, x0, y0, z1, Rx, Ry, Za);
        pos.push(x0, y0, z1, Rx, Ry, Zb, Rx, Ry, Za);
        pos.push(x1, y0, z1, x1, y0, z0, Rx, Ry, Za);
        pos.push(x1, y0, z0, Rx, Ry, Za, Rx, Ry, Zb);
        pos.push(x0, y0, z0, Rx, Ry, Za, x1, y0, z0);
        pos.push(x1, y0, z1, Rx, Ry, Zb, x0, y0, z1);
      }
      const m = new THREE.Mesh(triGeo(pos), mats.roof);
      m.castShadow = true;
      out.push(m);
    } else return buildRoof("hip", points, C, y0, style, mats, rng);
  } else if (kind === "mansard") {
    const h = clamp(span * 0.42, 3.5, 9);
    const inner = scalePoly(points, 0.7, C);
    const pos: number[] = [];
    const eo = edgesOf(points),
      ei = edgesOf(inner);
    for (let i = 0; i < eo.length; i++) {
      const a = eo[i]!,
        b = ei[i]!;
      pos.push(a.a[0], y0, a.a[1], a.b[0], y0, a.b[1], b.b[0], y0 + h, b.b[1]);
      pos.push(a.a[0], y0, a.a[1], b.b[0], y0 + h, b.b[1], b.a[0], y0 + h, b.a[1]);
    }
    const m = new THREE.Mesh(triGeo(pos), mats.roof);
    m.castShadow = true;
    out.push(m);
    const cap = new THREE.Mesh(extrudeMass(inner, 0.25), mats.roofDark);
    cap.position.y = y0 + h;
    out.push(cap);
  } else if (kind === "dome") {
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 16, 0, TAU, 0, Math.PI / 2), mats.roof);
    dome.scale.set(bb.w / 2, Math.min(bb.w, bb.d) * 0.5, bb.d / 2);
    dome.position.set(C[0], y0, C[1]);
    dome.castShadow = true;
    out.push(dome);
  }
  return out;
}

export function rooftopUnits(
  group: THREE.Group,
  topPts: Poly,
  C: Pt,
  topY: number,
  mats: Mats,
  rng: Rng,
  count: number,
): void {
  const bb = bbox(topPts);
  for (let i = 0; i < count; i++) {
    const w = rrange(rng, 2, Math.max(2.5, bb.w * 0.3)),
      d = rrange(rng, 2, Math.max(2.5, bb.d * 0.3)),
      h = rrange(rng, 1.5, 3.5);
    const u = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mats.metal);
    u.position.set(C[0] + (rng() - 0.5) * bb.w * 0.5, topY + h / 2, C[1] + (rng() - 0.5) * bb.d * 0.5);
    u.castShadow = true;
    group.add(u);
  }
}
