/**
 * Geometry builders ported from buildin-s. Pure Three.js geometry construction
 * (no renderer/GL context needed), compatible with three@^0.175.
 */
import * as THREE from "three";
import { polyShape, type Poly } from "./footprints";

/** Extrude a footprint polygon up by `h` (Y-up, base at y=0). */
export function extrudeMass(points: Poly, h: number): THREE.ExtrudeGeometry {
  const g = new THREE.ExtrudeGeometry(polyShape(points), { depth: h, bevelEnabled: false, steps: 1 });
  g.rotateX(-Math.PI / 2);
  return g;
}

/** Raw triangle soup → BufferGeometry with computed normals. */
export function triGeo(positions: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  g.computeVertexNormals();
  return g;
}

/** Orientation quaternion for a wall facing the given outward [nx, nz] normal. */
export function quatFromNormal(nx: number, nz: number): THREE.Quaternion {
  const z = new THREE.Vector3(nx, 0, nz).normalize();
  const x = new THREE.Vector3(0, 1, 0).cross(z).normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

export function rectWinGeo(depth: number): THREE.BoxGeometry {
  return new THREE.BoxGeometry(1, 1, depth);
}

export function archWinGeo(depth: number): THREE.ExtrudeGeometry {
  const s = new THREE.Shape(),
    w = 0.5;
  s.moveTo(-w, -0.5);
  s.lineTo(-w, 0.18);
  s.absarc(0, 0.18, w, Math.PI, 0, true);
  s.lineTo(w, -0.5);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false });
  g.translate(0, 0, -depth / 2);
  return g;
}

export function pointWinGeo(depth: number): THREE.ExtrudeGeometry {
  const s = new THREE.Shape(),
    w = 0.5;
  s.moveTo(-w, -0.5);
  s.lineTo(-w, 0.12);
  s.lineTo(0, 0.5);
  s.lineTo(w, 0.12);
  s.lineTo(w, -0.5);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false });
  g.translate(0, 0, -depth / 2);
  return g;
}

export function makeBox(w: number, h: number, d: number, mat: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
}

export function makeCyl(r: number, h: number, mat: THREE.Material, seg?: number): THREE.Mesh {
  return new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg || 14), mat);
}
