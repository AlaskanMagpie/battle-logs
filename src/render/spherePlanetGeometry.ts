import * as THREE from "three";
import type { MapData } from "../game/types";
import { sphereRadiusOf } from "../game/surface";
import { sphereTerrainEnabled, sphereTerrainHeightAtUnit } from "../game/sphereTerrain";

/**
 * High-segment sphere with vertices pushed along normals by {@link sphereTerrainHeightAtUnit}.
 */
export function buildDisplacedSphereGeometry(
  map: MapData,
  widthSegments = 112,
  heightSegments = 112,
): THREE.BufferGeometry {
  const R = sphereRadiusOf(map);
  const geo = new THREE.SphereGeometry(R, widthSegments, heightSegments);
  if (!sphereTerrainEnabled(map)) {
    return geo;
  }
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    v.normalize();
    const h = sphereTerrainHeightAtUnit(map, v.x, v.y, v.z);
    v.multiplyScalar(R + h);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}
