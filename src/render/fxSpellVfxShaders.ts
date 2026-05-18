import * as THREE from "three";

/** Shared time uniform for spell FX tick callbacks. */
export function setShaderTime(mat: THREE.Material, t: number): void {
  const u = (mat as THREE.ShaderMaterial).uniforms;
  if (u?.uTime) u.uTime.value = t;
}

export function setShaderAlpha(mat: THREE.Material, a: number): void {
  const u = (mat as THREE.ShaderMaterial).uniforms;
  if (u?.uAlpha) u.uAlpha.value = a;
}

/**
 * Volumetric-style ground fan (cone mesh) — radial rays, noise, rim hot without flat cardboard look.
 */
export function createSpellGroundFanMaterial(
  core: THREE.Color,
  rim: THREE.Color,
  reach: number,
  pulseHz: number,
): THREE.Material {
  try {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uAlpha: { value: 1 },
        uCore: { value: core.clone() },
        uRim: { value: rim.clone() },
        uReach: { value: reach },
        uPulseHz: { value: pulseHz },
      },
      vertexShader: `
        varying vec3 vModelPos;
        void main() {
          vModelPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform float uAlpha;
        uniform vec3 uCore;
        uniform vec3 uRim;
        uniform float uReach;
        uniform float uPulseHz;
        varying vec3 vModelPos;
        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        void main() {
          vec2 xz = vModelPos.xz;
          float r = length(xz) + 1e-4;
          float ang = atan(xz.x, xz.z);
          float n = hash(xz * 3.1 + uTime * 0.7);
          float rays = pow(0.5 + 0.5 * sin(ang * 9.0 + uTime * 4.2), 2.0);
          float fall = smoothstep(uReach * 1.05, 0.0, r);
          float edge = smoothstep(uReach * 0.08, 0.0, abs(r - uReach * 0.98));
          float pulse = 0.75 + 0.25 * sin(uTime * uPulseHz);
          vec3 col = mix(uCore, uRim, rays * 0.55 + edge * 0.45 + n * 0.12);
          float a = (0.22 + 0.55 * fall * pulse) * (0.55 + 0.45 * rays);
          gl_FragColor = vec4(col * (0.9 + edge * 0.35), clamp(a * uAlpha, 0.0, 1.0));
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
  } catch {
    return new THREE.MeshBasicMaterial({
      color: core.getHex(),
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
  }
}

/** Scrolling energy along bolt tubes (replaces 1px lines). */
export function createSpellBoltTubeMaterial(core: THREE.Color, hot: THREE.Color): THREE.Material {
  try {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uAlpha: { value: 1 },
        uCore: { value: core.clone() },
        uHot: { value: hot.clone() },
      },
      vertexShader: `
        varying vec2 vUv;
        varying float vAlong;
        void main() {
          vUv = uv;
          vAlong = uv.x;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform float uAlpha;
        uniform vec3 uCore;
        uniform vec3 uHot;
        varying vec2 vUv;
        varying float vAlong;
        void main() {
          float scan = 0.5 + 0.5 * sin(vAlong * 28.0 - uTime * 42.0);
          float rim = pow(1.0 - abs(vUv.y - 0.5) * 2.0, 1.6);
          vec3 col = mix(uCore, uHot, scan * rim);
          float a = (0.45 + 0.5 * rim) * (0.55 + 0.45 * scan);
          gl_FragColor = vec4(col, clamp(a * uAlpha, 0.0, 1.0));
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  } catch {
    return new THREE.MeshBasicMaterial({
      color: core.getHex(),
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  }
}

/** Soft additive ring / disc for impacts (replaces flat basic rings where upgraded). */
export function createSpellShockRingMaterial(inner: THREE.Color, outer: THREE.Color): THREE.Material {
  try {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uInner: { value: inner.clone() },
        uOuter: { value: outer.clone() },
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
        uniform vec3 uInner;
        uniform vec3 uOuter;
        varying vec2 vUv;
        void main() {
          float r = length(vUv - 0.5) * 2.0;
          float band = smoothstep(1.0, 0.35, r) * smoothstep(0.0, 0.2, r);
          float w = sin(uTime * 24.0 + r * 10.0) * 0.5 + 0.5;
          vec3 col = mix(uInner, uOuter, r * 0.85);
          gl_FragColor = vec4(col, band * (0.55 + 0.35 * w));
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
  } catch {
    return new THREE.MeshBasicMaterial({
      color: inner.getHex(),
      transparent: true,
      opacity: 0.65,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
  }
}
