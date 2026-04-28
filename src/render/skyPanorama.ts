import * as THREE from "three";

export type SkyPanoramaOptions = {
  radius: number;
  zoom: number;
  intensity?: number;
  rotation?: THREE.Euler;
};

export type SkyPanoramaMesh = THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;

export function createSkyPanorama(texture: THREE.Texture, opts: SkyPanoramaOptions): SkyPanoramaMesh {
  const uniforms = {
    map: { value: texture },
    zoom: { value: opts.zoom },
    intensity: { value: opts.intensity ?? 1 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `
      varying vec3 vWorldPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform sampler2D map;
      uniform float zoom;
      uniform float intensity;
      varying vec3 vWorldPos;
      const float PI = 3.141592653589793;
      void main() {
        vec3 dir = normalize(vWorldPos - cameraPosition);
        float u = atan(dir.z, dir.x) / (2.0 * PI) + 0.5;
        float v = asin(clamp(dir.y, -1.0, 1.0)) / PI + 0.5;
        vec2 uv = vec2(fract(0.5 + (u - 0.5) * zoom), clamp(0.5 + (v - 0.5) * zoom, 0.001, 0.999));
        gl_FragColor = texture2D(map, uv) * intensity;
      }
    `,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(opts.radius, 96, 48), mat);
  mesh.name = "SkyPanorama";
  mesh.frustumCulled = false;
  mesh.renderOrder = -10000;
  if (opts.rotation) mesh.rotation.copy(opts.rotation);
  return mesh;
}

export function setSkyPanoramaZoom(mesh: SkyPanoramaMesh | null, zoom: number): void {
  if (!mesh) return;
  const uniform = mesh.material.uniforms["zoom"];
  if (uniform) uniform.value = zoom;
}
