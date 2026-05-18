import * as THREE from "three";

/** Additive fireball / ember core — cheap rim pulse without texture fetches. */
export function createArtilleryOrbMaterial(): THREE.Material {
  try {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCore: { value: new THREE.Color(0xffaa55) },
        uHot: { value: new THREE.Color(0xffffcc) },
      },
      vertexShader: `
        varying vec3 vViewNormal;
        void main() {
          vViewNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform vec3 uCore;
        uniform vec3 uHot;
        varying vec3 vViewNormal;
        void main() {
          float rim = pow(1.0 - abs(vViewNormal.z), 2.2);
          float pulse = 0.82 + 0.18 * sin(uTime * 28.0);
          vec3 col = mix(uCore, uHot, rim * pulse);
          float a = 0.42 + 0.48 * rim * pulse;
          gl_FragColor = vec4(col, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  } catch {
    return new THREE.MeshBasicMaterial({
      color: 0xffaa55,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  }
}

/** Radial flash for summon lightning ring — additive wash. */
export function createSummonShockRingMaterial(): THREE.Material {
  try {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        varying vec2 vUv;
        void main() {
          float pulse = 0.72 + 0.28 * sin(uTime * 38.0);
          vec3 col = mix(vec3(0.42, 0.78, 1.0), vec3(1.0), vUv.x * 0.35 + 0.2);
          gl_FragColor = vec4(col, 0.78 * pulse);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
  } catch {
    return new THREE.MeshBasicMaterial({
      color: 0x8fd6ff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  }
}

export function tickArtilleryOrbTime(mat: THREE.Material, wallT: number): void {
  const u = (mat as THREE.ShaderMaterial).uniforms;
  if (u?.uTime) u.uTime.value = wallT;
}

export function tickSummonRingTime(mat: THREE.Material, wallT: number): void {
  const u = (mat as THREE.ShaderMaterial).uniforms;
  if (u?.uTime) u.uTime.value = wallT;
}
