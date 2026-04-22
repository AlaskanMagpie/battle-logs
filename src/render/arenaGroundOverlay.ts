import * as THREE from "three";

/** Stylized arena floor: additive grid + slow shimmer (GLSL). Separate mesh so the lit ground still receives shadows. */
export function createArenaGroundOverlayMesh(): {
  mesh: THREE.Mesh;
  uniforms: { uTime: { value: number }; uHalf: { value: number } };
} {
  const uniforms = {
    uTime: { value: 0 },
    uHalf: { value: 120 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    vertexShader: `
      varying vec2 vXZ;
      void main() {
        vXZ = position.xz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vXZ;
      uniform float uTime;
      uniform float uHalf;
      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }
      void main() {
        vec2 w = vXZ;
        float rim = 1.0 - smoothstep(uHalf * 0.72, uHalf * 1.02, length(w));
        float major = 0.22;
        vec2 fw = fract(w * major + 0.5) - 0.5;
        float gx = abs(fw.x);
        float gz = abs(fw.y);
        float line = smoothstep(0.38, 0.48, max(gx, gz));
        float pulse = 0.5 + 0.5 * sin(uTime * 0.35 + length(w) * 0.06);
        float n = hash(floor(w * 0.11)) * 0.35;
        vec3 col = vec3(0.18, 0.42, 0.72) * (0.35 + n + pulse * 0.25);
        float a = line * 0.14 * rim + rim * 0.02;
        gl_FragColor = vec4(col * a, a);
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.035;
  mesh.renderOrder = -5;
  mesh.frustumCulled = false;
  return { mesh, uniforms };
}
