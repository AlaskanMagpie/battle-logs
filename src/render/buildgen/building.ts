/**
 * Core procedural building generator ported from buildin-s `buildBuilding` +
 * `applyParts`. Returns a Three.js Group modeled Y-up from y=0; windows are
 * batched into <=3 InstancedMeshes for cheap rendering.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  bbox,
  edgesOf,
  FOOT,
  prepPoly,
  scalePoly,
  type FootKey,
  type Poly,
  type Pt,
  type Prepped,
} from "./footprints";
import { archWinGeo, extrudeMass, makeBox, makeCyl, pointWinGeo, quatFromNormal, rectWinGeo, triGeo } from "./geometry";
import { clamp, lerp, rint, TAU, type Rng } from "./rng";
import { makeMaterials, STYLES, type Mats, type Style, type StyleKey } from "./styles";
import { buildRoof, rooftopUnits } from "./roofs";

export interface BuildParams {
  style: StyleKey;
  foot: FootKey;
  storeys: number;
  width: number;
  depth: number;
  fh: number;
  /** Roof kind override; "auto" (default) uses the style's roof. */
  roof?: string;
  tiered?: boolean;
  /** Window density multiplier (default 1). */
  density?: number;
  seed: number;
  /** Static lit-window glow (see makeMaterials). */
  litEmissive?: number;
  /** Neon emissive scale for NoToneMapping renderers (default 1). */
  emissiveScale?: number;
  /**
   * Detail level. "low" (mobile) thins windows, drops frame bands, and trims
   * the heaviest ornaments to cut triangles + per-placement CPU. Default "high".
   */
  detail?: "high" | "low";
  /**
   * Collapse all non-instanced same-material meshes into one merged mesh each
   * (windows stay instanced) to cut draw calls dramatically. Default true.
   */
  mergeStatics?: boolean;
  /** Team — enemy structures get a subtle red tint so they read at a glance. */
  team?: "player" | "enemy";
}

interface Section {
  s: number;
  f0: number;
  f1: number;
}

interface WinXform {
  p: THREE.Vector3;
  q: THREE.Quaternion;
  s: THREE.Vector3;
}

export function buildBuilding(p: BuildParams, rng: Rng): THREE.Group {
  const style: Style = STYLES[p.style];
  const mats = makeMaterials(style, p.seed, { litEmissive: p.litEmissive, emissiveScale: p.emissiveScale });
  if (p.team === "enemy") {
    // Subtle red bias on opaque surfaces so the enemy team reads at a glance,
    // without touching glowing windows/neon.
    const red = new THREE.Color(0x8a2a2a);
    mats.wall.color.lerp(red, 0.22);
    mats.roof.color.lerp(red, 0.18);
    mats.roofDark.color.lerp(red, 0.18);
    mats.frame.color.lerp(red, 0.16);
    mats.accent.color.lerp(red, 0.16);
  }
  const group = new THREE.Group();
  const floors = p.storeys,
    fh = p.fh;
  const low = p.detail === "low";
  const density = (p.density ?? 1) * (low ? 0.7 : 1);
  const prepped = prepPoly(FOOT[p.foot](p.width, p.depth));
  const C = prepped.centroid;
  const tiered = p.tiered || style.tier;
  const sections: Section[] = [];
  if (tiered && floors >= 6) {
    const k = clamp(Math.round(floors / 9), 2, 4);
    let f0 = 0;
    for (let i = 0; i < k; i++) {
      const fcount = i === k - 1 ? floors - f0 : Math.max(1, Math.round((floors / k) * (i === 0 ? 1.4 : 1)));
      const f1 = Math.min(floors, f0 + fcount);
      sections.push({ s: 1 - i * 0.13, f0, f1 });
      f0 = f1;
      if (f0 >= floors) break;
    }
    sections[sections.length - 1]!.f1 = floors;
  } else sections.push({ s: 1, f0: 0, f1: floors });

  const winFrames: WinXform[] = [],
    winLit: WinXform[] = [],
    winUnlit: WinXform[] = [];
  const winW = style.winW,
    winHF = style.winHF,
    densityGap = style.gap / density,
    winDepth = 0.16,
    recess = style.recess || 0;
  const frontEdge = prepped.edges[0]!;

  for (const sec of sections) {
    const pts = sec.s === 1 ? prepped.points : scalePoly(prepped.points, sec.s, C);
    const y0 = sec.f0 * fh,
      h = (sec.f1 - sec.f0) * fh;
    const mass = new THREE.Mesh(extrudeMass(pts, h), mats.wall);
    mass.position.y = y0;
    mass.castShadow = true;
    mass.receiveShadow = true;
    group.add(mass);
    if (style.bands && !low) {
      for (let f = sec.f0; f <= sec.f1; f += style.bands === 2 ? 2 : 1) {
        for (const e of edgesOf(pts)) {
          const t = style.bands === 2 ? 0.35 : 0.18;
          const b = makeBox(e.len + 0.15, t, 0.25, mats.frame);
          b.position.set(e.mx + e.nx * 0.06, f * fh, e.mz + e.nz * 0.06);
          b.rotation.y = Math.atan2(e.nx, e.nz);
          group.add(b);
        }
      }
    }
    for (const e of edgesOf(pts)) {
      const cols = Math.max(1, Math.floor((e.len - 1.2) / (winW + densityGap)));
      const total = cols * winW + (cols - 1) * densityGap,
        start = (e.len - total) / 2;
      const dirx = (e.b[0] - e.a[0]) / e.len,
        dirz = (e.b[1] - e.a[1]) / e.len;
      for (let f = sec.f0; f < sec.f1; f++) {
        const cy = f * fh + fh * 0.5,
          wh = fh * winHF;
        for (let i = 0; i < cols; i++) {
          const dist = start + i * (winW + densityGap) + winW / 2;
          const wx = e.a[0] + dirx * dist,
            wz = e.a[1] + dirz * dist;
          if (
            f === 0 &&
            sec.f0 === 0 &&
            Math.abs(e.mx - frontEdge.mx) < 0.5 &&
            Math.abs(e.mz - frontEdge.mz) < 0.5 &&
            Math.abs(dist - e.len / 2) < 2.2
          )
            continue;
          const q = quatFromNormal(e.nx, e.nz);
          winFrames.push({
            p: new THREE.Vector3(wx + e.nx * (0.02 - recess), cy, wz + e.nz * (0.02 - recess)),
            q,
            s: new THREE.Vector3(winW * 0.92, wh, winDepth),
          });
          const gp = new THREE.Vector3(wx + e.nx * (0.05 - recess), cy, wz + e.nz * (0.05 - recess));
          (rng() < style.litRatio ? winLit : winUnlit).push({
            p: gp,
            q,
            s: new THREE.Vector3(winW * 0.74, wh * 0.86, winDepth * 0.5),
          });
        }
      }
    }
  }
  // door
  {
    const e = frontEdge,
      q = quatFromNormal(e.nx, e.nz),
      dh = Math.min(fh * 0.92, 4);
    const door = makeBox(2.6, dh, 0.3, mats.dark);
    door.position.set(e.mx + e.nx * 0.16, dh / 2, e.mz + e.nz * 0.16);
    door.quaternion.copy(q);
    group.add(door);
  }
  // instanced windows
  const winGeo =
    style.win === "arch" ? archWinGeo(winDepth) : style.win === "point" ? pointWinGeo(winDepth) : rectWinGeo(winDepth);
  const addInst = (list: WinXform[], mat: THREE.Material, geo: THREE.BufferGeometry): THREE.InstancedMesh | null => {
    if (!list.length) {
      geo.dispose();
      return null;
    }
    const inst = new THREE.InstancedMesh(geo, mat, list.length);
    const mtx = new THREE.Matrix4();
    for (let i = 0; i < list.length; i++) {
      mtx.compose(list[i]!.p, list[i]!.q, list[i]!.s);
      inst.setMatrixAt(i, mtx);
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = false;
    group.add(inst);
    return inst;
  };
  addInst(winFrames, mats.frame, winGeo.clone());
  const litMesh = addInst(winLit, mats.glassLit, winGeo.clone());
  addInst(winUnlit, mats.glassUnlit, winGeo.clone());
  winGeo.dispose();
  const ud = group.userData as Record<string, unknown>;
  ud["litMesh"] = litMesh;
  ud["mats"] = mats;
  // roof
  const topSec = sections[sections.length - 1]!;
  const topPts = topSec.s === 1 ? prepped.points : scalePoly(prepped.points, topSec.s, C);
  const topY = floors * fh;
  const roofKind = !p.roof || p.roof === "auto" ? style.roof_ : p.roof;
  for (const m of buildRoof(roofKind, topPts, C, topY, style, mats, rng)) group.add(m);
  applyParts(style, group, prepped, topPts, C, topY, floors, fh, mats, rng, low);
  if (p.mergeStatics !== false) mergeStaticMeshes(group);
  ud["floors"] = floors;
  return group;
}

/**
 * Collapse every non-instanced mesh that shares a material into a single merged
 * mesh, baking each mesh's local transform into its geometry. Window
 * InstancedMeshes are left untouched. Cuts a building from ~20-40 draw calls to
 * a handful. Buildings are untextured (solid colors), so UVs are dropped to let
 * mixed geometry sources (Box/Cyl/Extrude/triGeo) merge.
 */
function mergeStaticMeshes(group: THREE.Group): void {
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const remove: THREE.Mesh[] = [];
  for (const child of group.children) {
    if (child instanceof THREE.InstancedMesh) continue;
    if (!(child instanceof THREE.Mesh)) continue;
    const mat = child.material;
    if (Array.isArray(mat)) continue;
    child.updateMatrix();
    let g = child.geometry.clone();
    g.applyMatrix4(child.matrix);
    if (g.index) {
      const ni = g.toNonIndexed();
      g.dispose();
      g = ni;
    }
    for (const name of Object.keys(g.attributes)) {
      if (name !== "position" && name !== "normal") g.deleteAttribute(name);
    }
    g.morphAttributes = {};
    let list = byMat.get(mat);
    if (!list) byMat.set(mat, (list = []));
    list.push(g);
    remove.push(child);
  }
  for (const m of remove) {
    group.remove(m);
    m.geometry.dispose();
  }
  for (const [mat, geos] of byMat) {
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = false;
    mesh.userData["skipBuildOpacity"] = true;
    group.add(mesh);
  }
}

function applyParts(
  style: Style,
  group: THREE.Group,
  prepped: Prepped,
  topPts: Poly,
  C: Pt,
  topY: number,
  floors: number,
  fh: number,
  mats: Mats,
  rng: Rng,
  low: boolean,
): void {
  const bb = bbox(prepped.points);
  const span = Math.min(bb.w, bb.d);
  const place = (m: THREE.Mesh, x: number, y: number, z: number, ry?: number): THREE.Mesh => {
    m.position.set(x, y, z);
    if (ry) m.rotation.y = ry;
    m.castShadow = true;
    group.add(m);
    return m;
  };
  const n = style.name;
  if (n === "Modern") {
    rooftopUnits(group, topPts, C, topY, mats, rng, low ? 1 : 2);
    if (rng() > 0.5) {
      const a = makeCyl(0.12, 8, mats.metal, 8);
      place(a, C[0] + rng() * 4, topY + 4, C[1] + rng() * 4);
    }
  } else if (n === "Brutalist") {
    for (const e of prepped.edges) {
      if (!low && rng() < 0.4 && e.len > 8) {
        const hh = fh * Math.min(3, floors);
        const mod = makeBox(Math.min(e.len * 0.5, 7), hh, 3, mats.wall);
        const fy = fh * (1 + Math.floor(rng() * Math.max(1, floors - 3)));
        place(mod, e.mx + e.nx * 1.4, fy + hh / 2 - fh * 0.5, e.mz + e.nz * 1.4, Math.atan2(e.nx, e.nz));
      }
    }
    rooftopUnits(group, topPts, C, topY, mats, rng, 1);
  } else if (n === "Art Deco") {
    for (const e of edgesOf(topPts)) {
      const c = Math.max(2, Math.floor(e.len / 4));
      for (let i = 0; i <= c; i++) {
        const t = i / c,
          x = lerp(e.a[0], e.b[0], t),
          z = lerp(e.a[1], e.b[1], t);
        const pil = makeBox(0.6, floors * fh * 0.96, 0.6, mats.accent);
        place(pil, x + e.nx * 0.25, floors * fh * 0.48, z + e.nz * 0.25);
      }
    }
    let cy = topY,
      cs = 0.8;
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(extrudeMass(scalePoly(topPts, cs, C), 2.4), mats.accent);
      m.position.y = cy;
      m.castShadow = true;
      group.add(m);
      cy += 2.4;
      cs *= 0.72;
    }
    const mh = clamp(span * 0.6, 6, 16),
      mast = makeCyl(0.3, mh, mats.accent, 10);
    place(mast, C[0], cy + mh / 2, C[1]);
  } else if (n === "Gothic") {
    if (!low) {
      for (const e of edgesOf(prepped.points)) {
        if (e.len > 5) {
          const rib = makeBox(0.7, floors * fh, 0.9, mats.wall);
          place(rib, e.mx + e.nx * 0.45, floors * fh * 0.5, e.mz + e.nz * 0.45, Math.atan2(e.nx, e.nz));
        }
      }
    }
    for (const v of prepped.points) {
      const pin = new THREE.Mesh(new THREE.ConeGeometry(0.9, 4.5, 6), mats.roof);
      place(pin, v[0] * 0.96, topY + 2.2, v[1] * 0.96);
    }
  } else if (n === "Neoclassical") {
    const e = prepped.edges[0]!,
      c = low ? Math.max(2, Math.floor(e.len / 6)) : Math.max(4, Math.floor(e.len / 3)),
      colH = fh * Math.min(2, floors);
    const dirx = (e.b[0] - e.a[0]) / e.len,
      dirz = (e.b[1] - e.a[1]) / e.len;
    for (let i = 0; i <= c; i++) {
      const t = i / c,
        x = lerp(e.a[0], e.b[0], t),
        z = lerp(e.a[1], e.b[1], t);
      const col = makeCyl(0.55, colH, mats.accent, 12);
      place(col, x + e.nx * 2.4, colH / 2, z + e.nz * 2.4);
    }
    const ent = makeBox(e.len * 1.02, 1.4, 3.0, mats.accent);
    place(ent, e.mx + e.nx * 2.4, colH + 0.7, e.mz + e.nz * 2.4, Math.atan2(e.nx, e.nz));
    if (floors <= 4) {
      const w = e.len / 2,
        ax = e.mx + e.nx * 2.4,
        az = e.mz + e.nz * 2.4,
        L: Pt = [ax - dirx * w, az - dirz * w],
        R: Pt = [ax + dirx * w, az + dirz * w],
        pos: number[] = [];
      pos.push(L[0], colH + 1.4, L[1], R[0], colH + 1.4, R[1], ax, colH + 4.6, az);
      const ped = new THREE.Mesh(triGeo(pos), mats.accent);
      ped.castShadow = true;
      group.add(ped);
    }
    for (const ed of edgesOf(topPts)) {
      const cor = makeBox(ed.len + 0.6, 0.9, 0.8, mats.accent);
      place(cor, ed.mx + ed.nx * 0.3, topY - 0.6, ed.mz + ed.nz * 0.3, Math.atan2(ed.nx, ed.nz));
    }
  } else if (n === "Cyberpunk") {
    if (!low) {
      for (let f = 2; f < floors; f += rint(rng, 2, 4)) {
        const mat = rng() < 0.5 ? mats.neon1 : mats.neon2;
        if (!mat) continue;
        for (const e of edgesOf(topPts)) {
          const strip = makeBox(e.len, 0.18, 0.22, mat);
          strip.position.set(e.mx + e.nx * 0.12, f * fh, e.mz + e.nz * 0.12);
          strip.rotation.y = Math.atan2(e.nx, e.nz);
          group.add(strip);
        }
      }
    }
    if (mats.neon2) {
      const v = prepped.points[0]!,
        vstrip = makeBox(0.2, floors * fh * 0.9, 0.2, mats.neon2);
      place(vstrip, v[0], floors * fh * 0.5, v[1]);
    }
    rooftopUnits(group, topPts, C, topY, mats, rng, low ? 1 : 3);
    const mh = clamp(span, 8, 20),
      mast = makeCyl(0.18, mh, mats.metal, 8);
    place(mast, C[0], topY + mh / 2, C[1]);
    if (mats.neon1) {
      const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 10), mats.neon1);
      place(beacon, C[0], topY + mh, C[1]);
    }
    const dish = makeCyl(2.2, 0.5, mats.metal, 16);
    place(dish, C[0] + span * 0.2, topY + 2, C[1] - span * 0.2);
    dish.rotation.x = 0.5;
    if (mats.neon1) {
      const fe = prepped.edges[0]!,
        sign = makeBox(0.3, fh * 2.5, Math.min(bb.w, 8), mats.neon1);
      place(sign, fe.mx + fe.nx * 0.4, floors * fh * 0.6, fe.mz + fe.nz * 0.4, Math.atan2(fe.nx, fe.nz));
    }
  } else if (n === "Industrial") {
    const tx = C[0] + bb.w * 0.2,
      tz = C[1] + bb.d * 0.2,
      tr = Math.min(bb.w, bb.d) * 0.18;
    const tank = makeCyl(tr, 4, mats.metal, 14);
    place(tank, tx, topY + 5, tz);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(tr, 1.6, 14), mats.metal);
    place(cone, tx, topY + 7.6, tz);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU,
        leg = makeBox(0.2, 3, 0.2, mats.metal);
      place(leg, tx + Math.cos(a) * tr * 0.8, topY + 1.5, tz + Math.sin(a) * tr * 0.8);
    }
    for (let i = 0; i < 2; i++) {
      const st = makeCyl(0.7, 8, mats.dark, 12);
      place(st, C[0] - bb.w * 0.25 + i * 2.5, topY + 4, C[1] - bb.d * 0.2);
    }
    rooftopUnits(group, topPts, C, topY, mats, rng, 1);
  } else if (n === "Victorian") {
    const e = prepped.edges[0]!,
      bh = Math.min(floors, 3) * fh,
      bay = makeBox(3, bh, 1.8, mats.wall);
    place(bay, e.mx + e.nx * 0.9, bh / 2, e.mz + e.nz * 0.9, Math.atan2(e.nx, e.nz));
    for (let i = 0; i < 2; i++) {
      const ch = makeBox(1.2, 4, 1.2, mats.wall);
      place(ch, C[0] - bb.w * 0.2 + i * bb.w * 0.4, topY + 5, C[1] + (rng() - 0.5) * bb.d * 0.3);
    }
  } else if (n === "Mediterranean") {
    const e = prepped.edges[0]!;
    for (let f = 1; f < floors; f++) {
      const bal = makeBox(2.4, 0.3, 1.0, mats.accent);
      place(bal, e.mx + e.nx * 0.6, f * fh + 0.4, e.mz + e.nz * 0.6, Math.atan2(e.nx, e.nz));
    }
    if (rng() > 0.5) {
      const tw = makeBox(bb.w * 0.3, fh * 1.5, bb.d * 0.3, mats.wall);
      place(tw, bb.minx + bb.w * 0.2, floors * fh + fh * 0.75, bb.minz + bb.d * 0.2);
    }
  } else if (n === "Suburban") {
    const e = prepped.edges[0]!,
      dirx = (e.b[0] - e.a[0]) / e.len,
      dirz = (e.b[1] - e.a[1]) / e.len,
      gw = Math.min(bb.w * 0.4, 6);
    const gar = makeBox(gw, fh * 0.9, 4, mats.wall);
    place(gar, e.mx + e.nx * 2 + dirx * bb.w * 0.2, fh * 0.45, e.mz + e.nz * 2 + dirz * bb.d * 0.2, Math.atan2(e.nx, e.nz));
    const gd = makeBox(gw * 0.85, fh * 0.7, 0.2, mats.frame);
    place(gd, e.mx + e.nx * 4.05 + dirx * bb.w * 0.2, fh * 0.4, e.mz + e.nz * 4.05 + dirz * bb.d * 0.2, Math.atan2(e.nx, e.nz));
    const ch = makeBox(1, 3, 1, mats.wall);
    place(ch, C[0] + bb.w * 0.25, topY + 4, C[1]);
  }
}
