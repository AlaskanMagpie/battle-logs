import * as THREE from "three";
import { createSpellBoltTubeMaterial, createSpellGroundFanMaterial } from "./fxSpellVfxShaders";

/** Same layout as legacy `createGroundConeGeometry` in `fx.ts` — apex +Z fan on XZ plane near y. */
export function buildGroundConeGeometry(halfAngle: number, reach: number, y: number, segments: number): THREE.BufferGeometry {
  const positions: number[] = [0, y, 0];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const ang = -halfAngle + t * (2 * halfAngle);
    positions.push(Math.sin(ang) * reach, y * 0.92, Math.cos(ang) * reach);
  }
  const indices: number[] = [];
  for (let i = 0; i < segments; i++) {
    indices.push(0, 1 + i, 2 + i);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(positions), 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

export function meshGroundConeEnergy(
  halfAngle: number,
  reach: number,
  y: number,
  segments: number,
  coreHex: number,
  rimHex: number,
  pulseHz: number,
): THREE.Mesh {
  const geo = buildGroundConeGeometry(halfAngle, reach, y, segments);
  const mat = createSpellGroundFanMaterial(new THREE.Color(coreHex), new THREE.Color(rimHex), reach, pulseHz);
  return new THREE.Mesh(geo, mat);
}

export function vectorsFromBufferPositions(attr: THREE.BufferAttribute): THREE.Vector3[] {
  const a = attr.array as Float32Array;
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < a.length; i += 3) {
    out.push(new THREE.Vector3(a[i]!, a[i + 1]!, a[i + 2]!));
  }
  return out;
}

export function meshBoltTubeFromPoints(
  pts: THREE.Vector3[],
  radius: number,
  tubularSegments: number,
  radialSegments: number,
  coreHex: number,
  hotHex: number,
): THREE.Mesh {
  if (pts.length < 2) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 2, 6, 5),
      new THREE.MeshBasicMaterial({ color: coreHex, transparent: true, opacity: 0.6, depthWrite: false }),
    );
    m.position.copy(pts[0] ?? new THREE.Vector3());
    return m;
  }
  const curve = new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.35);
  const geo = new THREE.TubeGeometry(curve, tubularSegments, radius, radialSegments, false);
  const mat = createSpellBoltTubeMaterial(new THREE.Color(coreHex), new THREE.Color(hotHex));
  return new THREE.Mesh(geo, mat);
}

/** Particle specks along a cone rim + mid arcs — additive spheres, cheap budget. */
export function addConeMistParticles(
  group: THREE.Group,
  halfAngle: number,
  reach: number,
  y: number,
  count: number,
  seed: number,
  colorA: number,
  colorB: number,
): { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; vx: number; vy: number; vz: number }[] {
  const rnd = (i: number) => {
    const u = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
    return u - Math.floor(u);
  };
  const out: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; vx: number; vy: number; vz: number }[] = [];
  for (let i = 0; i < count; i++) {
    const t = rnd(i);
    const ang = -halfAngle + rnd(i + 50) * (2 * halfAngle);
    const rad = reach * (0.12 + rnd(i + 100) * 0.88);
    const mat = new THREE.MeshBasicMaterial({
      color: rnd(i + 2) > 0.45 ? colorA : colorB,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.05 + rnd(i + 3) * 0.07, 5, 4), mat);
    mesh.position.set(Math.sin(ang) * rad * 0.95, y + 0.08 + rnd(i + 4) * 0.35, Math.cos(ang) * rad * 0.95);
    const burst = 0.6 + rnd(i + 5) * 1.8;
    out.push({
      mesh,
      mat,
      vx: Math.sin(ang) * burst * 0.25,
      vz: Math.cos(ang) * burst * 0.25,
      vy: 0.8 + rnd(i + 6) * 1.4,
    });
    group.add(mesh);
  }
  return out;
}