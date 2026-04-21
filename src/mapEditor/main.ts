import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { TAP_GENERATION_MIN_SEP } from "../game/constants";
import type { MapData, RelaySlotDef, TapSlotDef, Vec2 } from "../game/types";
import { collectMeshes, sampleTerrainSurface } from "./meshSample";

type PlaceMode = "tap" | "pRelay" | "eRelay" | "pStart" | "eStart";

let baseMap: MapData | null = null;
let terrainMeshes: THREE.Mesh[] = [];
let terrainGroup: THREE.Group | null = null;
let blobTerrainUrl: string | null = null;

const tapSlots: TapSlotDef[] = [];
const playerRelaySlots: RelaySlotDef[] = [];
const enemyRelaySlots: RelaySlotDef[] = [];
let playerStart: Vec2 = { x: 0, z: 0 };
let enemyStart: Vec2 = { x: 0, z: 0 };

let placeMode: PlaceMode = "tap";
let tapIdCounter = 0;
let prIdCounter = 0;
let erIdCounter = 0;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0c10);
const camera = new THREE.PerspectiveCamera(48, 1, 0.5, 2000);
camera.position.set(120, 90, 120);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
const canvas = renderer.domElement;
canvas.style.flex = "1";
canvas.style.minWidth = "0";
canvas.style.minHeight = "0";

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.target.set(0, 0, 0);

const grid = new THREE.GridHelper(320, 32, 0x2a3545, 0x1a2230);
grid.position.y = 0.01;
scene.add(grid);

const amb = new THREE.AmbientLight(0xcfd9ff, 0.45);
const hem = new THREE.HemisphereLight(0x9eb7ff, 0x1a1e28, 0.4);
const sun = new THREE.DirectionalLight(0xfff4e6, 0.95);
sun.position.set(-80, 140, 40);
sun.castShadow = true;
scene.add(amb, hem, sun);

const markers = new THREE.Group();
scene.add(markers);

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

function clearTerrain(): void {
  if (terrainGroup) {
    terrainGroup.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry?.dispose();
        const mat = m.material;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else (mat as THREE.Material | undefined)?.dispose?.();
      }
    });
    scene.remove(terrainGroup);
    terrainGroup = null;
  }
  terrainMeshes = [];
  if (blobTerrainUrl) {
    URL.revokeObjectURL(blobTerrainUrl);
    blobTerrainUrl = null;
  }
}

function rebuildMarkers(): void {
  while (markers.children.length) {
    const c = markers.children[0]!;
    markers.remove(c);
    if ((c as THREE.Mesh).isMesh) {
      (c as THREE.Mesh).geometry.dispose();
      ((c as THREE.Mesh).material as THREE.Material).dispose();
    }
  }
  const mk = (x: number, z: number, color: number, y = 1.2) => {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(1.1, 14, 12),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.25 }),
    );
    m.position.set(x, y, z);
    m.castShadow = true;
    markers.add(m);
  };
  for (const t of tapSlots) mk(t.x, t.z, 0x5fc48a);
  for (const r of playerRelaySlots) mk(r.x, r.z, 0x6aa6ff);
  for (const r of enemyRelaySlots) mk(r.x, r.z, 0xff6060);
  mk(playerStart.x, playerStart.z, 0x4da3ff, 2.2);
  mk(enemyStart.x, enemyStart.z, 0xff8844, 2.2);
}

function pickXZ(clientX: number, clientY: number, rect: DOMRect): { x: number; z: number; y: number } | null {
  ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -(((clientY - rect.top) / rect.height) * 2 - 1);
  raycaster.setFromCamera(ndc, camera);
  if (terrainMeshes.length > 0) {
    const hits = raycaster.intersectObjects(terrainMeshes, true);
    const p = hits[0]?.point;
    if (p) return { x: p.x, y: p.y, z: p.z };
  }
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const pt = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(plane, pt)) return { x: pt.x, y: pt.y, z: pt.z };
  return null;
}

function applyBaseMap(m: MapData): void {
  baseMap = m;
  tapSlots.length = 0;
  playerRelaySlots.length = 0;
  enemyRelaySlots.length = 0;
  tapSlots.push(...m.tapSlots.map((t) => ({ ...t })));
  playerRelaySlots.push(...m.playerRelaySlots.map((t) => ({ ...t })));
  enemyRelaySlots.push(...m.enemyRelaySlots.map((t) => ({ ...t })));
  playerStart = { ...m.playerStart };
  enemyStart = { ...(m.enemyStart ?? { x: -m.playerStart.x, z: m.playerStart.z }) };
  tapIdCounter = tapSlots.length;
  prIdCounter = playerRelaySlots.length;
  erIdCounter = enemyRelaySlots.length;
  rebuildMarkers();
}

async function loadBaseJson(file: File): Promise<void> {
  const text = await file.text();
  const m = JSON.parse(text) as MapData;
  applyBaseMap(m);
  log(`Loaded base map from ${file.name} (${tapSlots.length} taps).`);
}

async function loadTerrainGlb(file: File): Promise<void> {
  clearTerrain();
  blobTerrainUrl = URL.createObjectURL(file);
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(blobTerrainUrl);
  const g = new THREE.Group();
  g.add(gltf.scene);
  g.name = "editor_terrain";
  scene.add(g);
  terrainGroup = g;
  terrainMeshes = collectMeshes(g);
  for (const m of terrainMeshes) {
    m.castShadow = true;
    m.receiveShadow = true;
  }
  log(`GLB loaded: ${terrainMeshes.length} mesh(es).`);
}

async function loadTerrainObj(file: File): Promise<void> {
  clearTerrain();
  const text = await file.text();
  const obj = new OBJLoader().parse(text);
  const g = new THREE.Group();
  g.add(obj);
  g.name = "editor_terrain_obj";
  scene.add(g);
  terrainGroup = g;
  terrainMeshes = collectMeshes(g);
  for (const m of terrainMeshes) {
    m.castShadow = true;
    m.receiveShadow = true;
  }
  log(`OBJ loaded: ${terrainMeshes.length} mesh(es).`);
}

function log(msg: string): void {
  const el = document.getElementById("me-log");
  if (el) el.textContent = `${msg}\n${el.textContent}`.slice(0, 4000);
}

function exportMap(terrainUrlField: string): void {
  if (!baseMap) {
    log("Load a base map.json first.");
    return;
  }
  const terrainGlbUrl = terrainUrlField.trim() || undefined;
  const out: MapData = {
    ...baseMap,
    useAuthorTapSlots: true,
    tapSlots: tapSlots.map((t) => ({ ...t })),
    playerRelaySlots: playerRelaySlots.map((t) => ({ ...t })),
    enemyRelaySlots: enemyRelaySlots.map((t) => ({ ...t })),
    playerStart: { ...playerStart },
    enemyStart: { ...enemyStart },
    terrainGlbUrl,
  };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "map.local.json";
  a.click();
  URL.revokeObjectURL(a.href);
  log("Exported map.local.json — merge rules: place next to map.json or use Vite public/. For terrain, copy your GLB into public/ and set the URL field before export.");
}

function randomTaps(countStr: string): void {
  const n = Math.max(1, Math.min(80, Math.floor(Number(countStr) || 8)));
  if (terrainMeshes.length === 0) {
    log("Load a GLB/OBJ terrain first so nodes can land on the mesh.");
    return;
  }
  const half = baseMap?.world.halfExtents ?? 160;
  const pts = sampleTerrainSurface(terrainMeshes, half, n, Math.random, TAP_GENERATION_MIN_SEP);
  for (const p of pts) {
    tapSlots.push({ id: `tap_ed_${tapIdCounter++}`, x: p.x, z: p.z });
  }
  rebuildMarkers();
  log(`Added ${pts.length} random tap(s) on mesh surface.`);
}

function onCanvasPointerDown(ev: PointerEvent): void {
  if (ev.button !== 0) return;
  const rect = canvas.getBoundingClientRect();
  const hit = pickXZ(ev.clientX, ev.clientY, rect);
  if (!hit) return;
  const { x, z } = hit;
  switch (placeMode) {
    case "tap":
      tapSlots.push({ id: `tap_ed_${tapIdCounter++}`, x, z });
      break;
    case "pRelay":
      playerRelaySlots.push({ id: `p_ed_${prIdCounter++}`, x, z });
      break;
    case "eRelay":
      enemyRelaySlots.push({ id: `e_ed_${erIdCounter++}`, x, z });
      break;
    case "pStart":
      playerStart = { x, z };
      break;
    case "eStart":
      enemyStart = { x, z };
      break;
    default:
      break;
  }
  rebuildMarkers();
}

function layout(): void {
  const wrap = document.getElementById("me-canvas-wrap");
  if (!wrap) return;
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
}

function loop(): void {
  requestAnimationFrame(loop);
  controls.update();
  renderer.render(scene, camera);
}

function wireUi(): void {
  document.getElementById("me-base")?.addEventListener("change", (ev) => {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (f) void loadBaseJson(f);
  });
  document.getElementById("me-glb")?.addEventListener("change", (ev) => {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (f) void loadTerrainGlb(f).catch((e) => log(String(e)));
  });
  document.getElementById("me-obj")?.addEventListener("change", (ev) => {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (f) void loadTerrainObj(f).catch((e) => log(String(e)));
  });
  document.getElementById("me-fetch-base")?.addEventListener("click", async () => {
    try {
      const res = await fetch("/map.json");
      if (!res.ok) throw new Error(String(res.status));
      applyBaseMap((await res.json()) as MapData);
      log("Fetched /map.json as base.");
    } catch (e) {
      log(String(e));
    }
  });
  document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      placeMode = btn.dataset.mode as PlaceMode;
      document.querySelectorAll("[data-mode]").forEach((b) => b.classList.remove("me-active"));
      btn.classList.add("me-active");
    });
  });
  document.getElementById("me-clear-taps")?.addEventListener("click", () => {
    tapSlots.length = 0;
    rebuildMarkers();
    log("Cleared taps.");
  });
  document.getElementById("me-random-taps")?.addEventListener("click", () => {
    const n = (document.getElementById("me-random-count") as HTMLInputElement)?.value ?? "8";
    randomTaps(n);
  });
  document.getElementById("me-export")?.addEventListener("click", () => {
    const url = (document.getElementById("me-terrain-url") as HTMLInputElement)?.value ?? "";
    exportMap(url);
  });
  canvas.addEventListener("pointerdown", onCanvasPointerDown);
  window.addEventListener("resize", layout);
}

function mount(): void {
  const wrap = document.getElementById("me-canvas-wrap");
  if (!wrap) return;
  wrap.appendChild(canvas);
  wireUi();
  layout();
  void fetch("/map.json")
    .then((r) => r.json())
    .then((m) => {
      applyBaseMap(m as MapData);
      log("Auto-loaded /map.json. Load GLB/OBJ, pick a mode, click mesh to place.");
    })
    .catch(() => log("Could not auto-load /map.json — use file picker."));
  loop();
}

mount();
