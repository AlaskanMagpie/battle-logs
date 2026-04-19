import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { getCatalogEntry } from "../game/catalog";
import {
  HERO_CLAIM_CHANNEL_SEC,
  TAP_YIELD_MAX,
  TERRITORY_RADIUS,
  TICK_HZ,
} from "../game/constants";
import { unitStatsForCatalog } from "../game/sim/systems/helpers";
import {
  dominantSignal,
  findKeep,
  signalColorHex,
  territorySources,
  type GameState,
} from "../game/state";
import type { SignalType, StructureCatalogEntry, UnitSizeClass } from "../game/types";
import { isStructureEntry } from "../game/types";
import { createFxHost, spawnCastFx, spawnSiegeTell, stepFx, type FxHost } from "./fx";
import { requestGlbForHero, requestGlbForTower, requestGlbForUnit } from "./glbPool";

function unitScale(size: UnitSizeClass): number {
  switch (size) {
    case "Swarm":
      return 0.55;
    case "Line":
      return 0.75;
    case "Heavy":
      return 1.15;
    case "Titan":
      return 1.7;
  }
}

function structureDims(entry: StructureCatalogEntry | null): { w: number; h: number; d: number } {
  if (!entry) return { w: 3, h: 5, d: 3 };
  const signals = entry.signalTypes;
  const isBastion = signals.filter((s) => s === "Bastion").length >= 2;
  const isVanguard = signals.filter((s) => s === "Vanguard").length >= 1;
  const isReclaim = signals.filter((s) => s === "Reclaim").length >= 1;
  if (entry.producedSizeClass === "Titan") return { w: 5.2, h: 9.5, d: 5.2 };
  if (entry.producedSizeClass === "Heavy" && isBastion) return { w: 6.2, h: 4.2, d: 6.2 };
  if (entry.producedSizeClass === "Heavy") return { w: 4.6, h: 5.8, d: 4.6 };
  if (isBastion) return { w: 6, h: 3.6, d: 6 };
  if (isVanguard && isReclaim) return { w: 3.8, h: 5.6, d: 3.8 };
  if (isVanguard) return { w: 2.6, h: 7.2, d: 2.6 };
  if (isReclaim) return { w: 3.8, h: 4.8, d: 3.8 };
  return { w: 3.2, h: 5, d: 3.2 };
}

function hsl(hex: number, dl: number): THREE.Color {
  const c = new THREE.Color(hex);
  const h = { h: 0, s: 0, l: 0 };
  c.getHSL(h);
  c.setHSL(h.h, h.s, Math.max(0.05, Math.min(0.95, h.l + dl)));
  return c;
}

function matFor(color: number, roughness = 0.82, metalness = 0.08): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

/** Builds a reusable CanvasTexture-backed Sprite for floating world-space labels.
 *  Canvas is 256x72 at 2x DPR so text stays crisp when scaled to ~6 world units wide. */
interface LabelSprite {
  sprite: THREE.Sprite;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  lastText: string;
  lastAccent: string;
}

function makeLabelSprite(initialText: string, accent = "#6ae1ff"): LabelSprite {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 144;
  const ctx = canvas.getContext("2d")!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.renderOrder = 999;
  // 8 world units wide, ~2.25 tall keeps legibility without dwarfing pillars.
  sprite.scale.set(8, 2.25, 1);
  const ls: LabelSprite = { sprite, canvas, ctx, texture, lastText: "", lastAccent: "" };
  drawLabel(ls, initialText, accent);
  return ls;
}

function drawLabel(label: LabelSprite, text: string, accent: string): void {
  if (label.lastText === text && label.lastAccent === accent) return;
  label.lastText = text;
  label.lastAccent = accent;
  const { ctx, canvas } = label;
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const r = 28;
  ctx.beginPath();
  ctx.moveTo(r, 8);
  ctx.lineTo(W - r, 8);
  ctx.quadraticCurveTo(W - 8, 8, W - 8, r + 8);
  ctx.lineTo(W - 8, H - r - 8);
  ctx.quadraticCurveTo(W - 8, H - 8, W - r, H - 8);
  ctx.lineTo(r, H - 8);
  ctx.quadraticCurveTo(8, H - 8, 8, H - r - 8);
  ctx.lineTo(8, r + 8);
  ctx.quadraticCurveTo(8, 8, r, 8);
  ctx.closePath();
  ctx.fillStyle = "rgba(6, 10, 18, 0.82)";
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = accent;
  ctx.stroke();
  ctx.font = "bold 54px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#f4fbff";
  ctx.shadowColor = "rgba(0,0,0,0.9)";
  ctx.shadowBlur = 6;
  ctx.fillText(text, W / 2, H / 2 + 2);
  ctx.shadowBlur = 0;
  label.texture.needsUpdate = true;
}

function addVanguardSilhouette(
  root: THREE.Group,
  { w, h, d }: { w: number; h: number; d: number },
  color: number,
  accent: number,
): void {
  const baseH = h * 0.2;
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(w * 0.95, baseH, d * 0.95),
    matFor(hsl(color, -0.12).getHex()),
  );
  base.position.y = baseH / 2;
  root.add(base);

  const towerH = h * 0.55;
  const tower = new THREE.Mesh(
    new THREE.CylinderGeometry(w * 0.22, w * 0.3, towerH, 8),
    matFor(color),
  );
  tower.position.y = baseH + towerH / 2;
  root.add(tower);

  const coneH = h * 0.3;
  const cone = new THREE.Mesh(new THREE.ConeGeometry(w * 0.22, coneH, 8), matFor(accent, 0.55, 0.35));
  cone.position.y = baseH + towerH + coneH / 2;
  root.add(cone);

  for (const dir of [1, -1]) {
    const fin = new THREE.Mesh(
      new THREE.BoxGeometry(w * 0.08, towerH * 0.7, d * 0.45),
      matFor(hsl(color, -0.08).getHex()),
    );
    fin.position.set(dir * w * 0.32, baseH + towerH * 0.55, 0);
    root.add(fin);
  }
}

function addBastionSilhouette(
  root: THREE.Group,
  { w, h, d }: { w: number; h: number; d: number },
  color: number,
): void {
  const baseH = h * 0.55;
  const base = new THREE.Mesh(new THREE.BoxGeometry(w, baseH, d), matFor(color));
  base.position.y = baseH / 2;
  root.add(base);

  const topH = h * 0.35;
  const top = new THREE.Mesh(
    new THREE.BoxGeometry(w * 0.7, topH, d * 0.7),
    matFor(hsl(color, 0.06).getHex()),
  );
  top.position.y = baseH + topH / 2;
  root.add(top);

  const crenel = w / 5;
  for (let i = 0; i < 4; i++) {
    const c = new THREE.Mesh(
      new THREE.BoxGeometry(crenel * 0.7, h * 0.12, d * 0.15),
      matFor(hsl(color, -0.1).getHex()),
    );
    c.position.set(-w / 2 + crenel * (i + 0.5), baseH - 0.02, d * 0.42);
    root.add(c);
    const c2 = c.clone();
    c2.position.z = -d * 0.42;
    root.add(c2);
  }
}

function addReclaimSilhouette(
  root: THREE.Group,
  { w, h }: { w: number; h: number; d: number },
  color: number,
  accent: number,
): void {
  const baseH = h * 0.35;
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(w * 0.48, w * 0.52, baseH, 10),
    matFor(hsl(color, -0.1).getHex()),
  );
  base.position.y = baseH / 2;
  root.add(base);

  const bulbH = h * 0.4;
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(w * 0.38, 16, 12), matFor(color, 0.7, 0.02));
  bulb.position.y = baseH + bulbH / 2;
  bulb.scale.set(1, 0.9, 1);
  root.add(bulb);

  for (let i = 0; i < 4; i++) {
    const ang = (i / 4) * Math.PI * 2;
    const stalk = new THREE.Mesh(
      new THREE.CylinderGeometry(w * 0.05, w * 0.08, h * 0.5, 6),
      matFor(hsl(color, 0.02).getHex()),
    );
    stalk.position.set(Math.cos(ang) * w * 0.32, baseH + h * 0.25, Math.sin(ang) * w * 0.32);
    stalk.rotation.z = Math.cos(ang) * 0.25;
    stalk.rotation.x = Math.sin(ang) * 0.25;
    root.add(stalk);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(w * 0.08, 8, 6), matFor(accent, 0.5, 0.3));
    tip.position.copy(stalk.position).setY(baseH + h * 0.5);
    root.add(tip);
  }
}

function buildStructureSilhouette(entry: StructureCatalogEntry, team: "player" | "enemy"): THREE.Group {
  const g = new THREE.Group();
  const silo = new THREE.Group();
  silo.name = "structure-silhouette";
  const dims = structureDims(entry);
  const signals = entry.signalTypes;
  const dom = dominantSignal(entry) ?? "Vanguard";
  const color = signalColorHex(dom);
  const accent = team === "enemy" ? 0xff6b6b : hsl(color, 0.2).getHex();

  const sCount = {
    Vanguard: signals.filter((s) => s === "Vanguard").length,
    Bastion: signals.filter((s) => s === "Bastion").length,
    Reclaim: signals.filter((s) => s === "Reclaim").length,
  };

  if (sCount.Bastion >= 2 || (sCount.Bastion >= 1 && sCount.Vanguard === 0 && sCount.Reclaim === 0)) {
    addBastionSilhouette(silo, dims, color);
  } else if (sCount.Vanguard >= 2 || (sCount.Vanguard >= 1 && sCount.Bastion === 0 && sCount.Reclaim === 0)) {
    addVanguardSilhouette(silo, dims, color, accent);
  } else if (sCount.Reclaim >= 2 || (sCount.Reclaim >= 1 && sCount.Vanguard === 0 && sCount.Bastion === 0)) {
    addReclaimSilhouette(silo, dims, color, accent);
  } else if (sCount.Vanguard && sCount.Bastion) {
    addBastionSilhouette(silo, { w: dims.w, h: dims.h * 0.6, d: dims.d }, color);
    const spire = new THREE.Mesh(
      new THREE.ConeGeometry(dims.w * 0.18, dims.h * 0.45, 8),
      matFor(accent, 0.55, 0.3),
    );
    spire.position.y = dims.h * 0.78;
    silo.add(spire);
  } else if (sCount.Reclaim && sCount.Bastion) {
    addBastionSilhouette(silo, { w: dims.w, h: dims.h * 0.6, d: dims.d }, color);
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(dims.w * 0.3, 12, 8),
      matFor(accent, 0.6, 0.2),
    );
    bulb.position.y = dims.h * 0.82;
    silo.add(bulb);
  } else if (sCount.Vanguard && sCount.Reclaim) {
    addReclaimSilhouette(silo, { w: dims.w * 0.8, h: dims.h * 0.55, d: dims.d * 0.8 }, color, accent);
    const spike = new THREE.Mesh(
      new THREE.ConeGeometry(dims.w * 0.14, dims.h * 0.5, 8),
      matFor(signalColorHex("Vanguard"), 0.55, 0.25),
    );
    spike.position.y = dims.h * 0.72;
    silo.add(spike);
  } else {
    addVanguardSilhouette(silo, dims, color, accent);
  }

  g.add(silo);
  (g.userData as Record<string, unknown>)["structureSilhouette"] = silo;

  // GLB swap anchor (hidden once a tower model loads).
  const phMat = matFor(hsl(color, -0.35).getHex(), 0.92, 0.04);
  phMat.transparent = true;
  phMat.opacity = 0.04;
  const placeholder = new THREE.Mesh(
    new THREE.BoxGeometry(dims.w * 0.55, dims.h * 0.52, dims.d * 0.55),
    phMat,
  );
  placeholder.position.y = dims.h * 0.32;
  placeholder.castShadow = false;
  placeholder.userData["isPlaceholder"] = true;
  g.add(placeholder);
  (g.userData as Record<string, unknown>)["bodyMesh"] = placeholder;

  // Team plinth underneath for clarity.
  const plinth = new THREE.Mesh(
    new THREE.CylinderGeometry(Math.max(dims.w, dims.d) * 0.65, Math.max(dims.w, dims.d) * 0.7, 0.18, 20),
    new THREE.MeshStandardMaterial({
      color: team === "player" ? 0x2a5c8a : 0x8a2a2a,
      roughness: 0.9,
      transparent: true,
      opacity: 0.9,
    }),
  );
  plinth.position.y = 0.09;
  plinth.receiveShadow = true;
  g.add(plinth);

  g.traverse((c) => {
    if (c instanceof THREE.Mesh) {
      c.castShadow = true;
      c.receiveShadow = true;
    }
  });

  (g.userData as Record<string, unknown>)["dims"] = dims;
  return g;
}

function buildUnitMesh(signal: SignalType | undefined, team: "player" | "enemy", size: UnitSizeClass): THREE.Group {
  const g = new THREE.Group();
  const s = unitScale(size);

  const sigColor = signalColorHex(signal);
  const color = team === "enemy" ? hsl(sigColor, -0.18).getHex() : sigColor;

  let body: THREE.Mesh;
  if (size === "Swarm") {
    body = new THREE.Mesh(
      new THREE.ConeGeometry(s * 0.48, s * 1.05, 8),
      matFor(color, 0.55, 0.1),
    );
    body.position.y = s * 0.52;
  } else if (size === "Line") {
    body = new THREE.Mesh(
      new THREE.BoxGeometry(s, s * 1.1, s * 0.6),
      matFor(color, 0.7, 0.1),
    );
    body.position.y = s * 0.55;
  } else if (size === "Heavy") {
    body = new THREE.Mesh(
      new THREE.BoxGeometry(s * 1.1, s * 0.9, s * 1.1),
      matFor(color, 0.78, 0.15),
    );
    body.position.y = s * 0.45;
  } else {
    body = new THREE.Mesh(
      new THREE.CylinderGeometry(s * 0.55, s * 0.72, s * 1.4, 10),
      matFor(color, 0.7, 0.18),
    );
    body.position.y = s * 0.7;
  }
  body.castShadow = true;
  body.userData["isPlaceholder"] = true;
  g.add(body);
  (g.userData as Record<string, unknown>)["bodyMesh"] = body;

  const ringColor = team === "player" ? 0x4da3ff : 0xff4d4d;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(s * 0.62, s * 0.85, 24),
    new THREE.MeshBasicMaterial({
      color: ringColor,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.72,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.03;
  g.add(ring);

  return g;
}

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  private readonly ground: THREE.Mesh;
  private grid: THREE.GridHelper;
  private readonly root = new THREE.Group();
  private readonly markers = new THREE.Group();
  private readonly entities = new THREE.Group();
  private readonly decor = new THREE.Group();
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private unitMeshes = new Map<number, THREE.Object3D>();
  private structureMeshes = new Map<number, THREE.Object3D>();
  private tapMeshes = new Map<string, THREE.Mesh>();
  private tapYieldArcs = new Map<string, THREE.Mesh>();
  private tapClaimArcs = new Map<string, THREE.Mesh>();
  /** Floating "Stand to claim" / "Depleted" label sprites keyed by tap defId. */
  private tapLabels = new Map<string, LabelSprite>();
  /** "Next node" highlight ring on the nearest unclaimed tap to the hero. */
  private nearestTapRing: THREE.Mesh | null = null;
  private territoryGroup = new THREE.Group();
  private territoryMeshes: THREE.Mesh[] = [];
  private territoryKey = "";
  private heroGroup: THREE.Group | null = null;
  private heroHpBarBg: THREE.Mesh | null = null;
  private heroHpBarFg: THREE.Mesh | null = null;
  private enemyHeroGroup: THREE.Group | null = null;
  private enemyHeroHpBarBg: THREE.Mesh | null = null;
  private enemyHeroHpBarFg: THREE.Mesh | null = null;
  /** Per enemy-relay (Dark Fortress) id → marker cylinder. */
  private relayMeshes = new Map<string, THREE.Mesh>();
  /** Wizard-Keep marker (violet ring + HP arc on the ground). */
  private keepRing: THREE.Mesh | null = null;
  private keepHpArc: THREE.Mesh | null = null;
  /** Per structure: hold-orders floating red cube. */
  private holdCubes = new Map<number, THREE.Mesh>();
  /** Per enemy camp id: HP orb. */
  private coreOrbs = new Map<string, THREE.Mesh>();
  /** Selected structure's blue halo + rally line + flag. */
  private selectHalo: THREE.Mesh | null = null;
  private attackRangeRing: THREE.Mesh | null = null;
  private auraRangeRing: THREE.Mesh | null = null;
  private rallyLine: THREE.Line | null = null;
  private rallyFlag: THREE.Mesh | null = null;
  private campAggroRings = new Map<string, THREE.Mesh>();
  private campWakeRings = new Map<string, THREE.Mesh>();
  private decorBuilt = false;

  private ghost: THREE.Mesh | null = null;
  private cmdGhost: THREE.Mesh | null = null;
  private cmdGhostCore: THREE.Mesh | null = null;
  private readonly controls: OrbitControls;
  private readonly clock = new THREE.Clock();
  private readonly fx: FxHost;
  private lastFxTick = -1;
  private lastSiegeTick = -1;
  private currentState: GameState | null = null;
  private worldPlaneHalf = 0;
  private readonly unitPrevHp = new Map<number, number>();
  private readonly structurePrevHp = new Map<number, number>();
  private readonly relayPrevHp = new Map<string, number>();
  /** Seconds of forward lunge after a wizard strike FX. */
  private heroLungeTimer = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0e1116);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.5, 650);
    this.camera.position.set(82, 96, 82);
    this.camera.lookAt(0, 4, 0);

    this.scene.add(new THREE.AmbientLight(0xcfd9ff, 0.38));
    this.scene.add(new THREE.HemisphereLight(0x9eb7ff, 0x1a1e28, 0.35));
    const sun = new THREE.DirectionalLight(0xfff4e6, 1.05);
    sun.position.set(-55, 110, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.00025;
    const sc = sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -220;
    sc.right = 220;
    sc.top = 220;
    sc.bottom = -220;
    sc.near = 10;
    sc.far = 520;
    sc.updateProjectionMatrix();
    this.scene.add(sun);

    const groundMat = new THREE.MeshStandardMaterial({ color: 0x1b2430, roughness: 0.92, metalness: 0.04 });
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    this.grid = new THREE.GridHelper(220, 44, 0x2a3545, 0x1f2937);
    this.grid.position.y = 0.02;
    this.scene.add(this.grid);

    this.territoryGroup.name = "territory";
    this.root.add(this.decor, this.markers, this.entities, this.territoryGroup);
    this.scene.add(this.root);

    this.fx = createFxHost(this.scene);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 48;
    this.controls.maxDistance = 280;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.08;
    this.controls.minPolarAngle = 0.36;
    this.controls.zoomSpeed = 0.82;
    this.controls.rotateSpeed = 0.42;
    this.controls.panSpeed = 0.58;
    this.controls.enableRotate = true;
    this.controls.enablePan = false;
    // Middle = orbit; left/right disabled so LMB/RMB go to the game (RMB move on canvas).
    (this.controls as unknown as { mouseButtons: { LEFT: number; MIDDLE: number; RIGHT: number } }).mouseButtons = {
      LEFT: -1,
      MIDDLE: 0,
      RIGHT: -1,
    };
  }

  setSize(w: number, h: number): void {
    this.renderer.setSize(w, h, false);
    const aspect = w / Math.max(1, h);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  setControlsEnabled(enabled: boolean): void {
    this.controls.enabled = enabled;
  }

  pickGround(clientX: number, clientY: number, rect: DOMRect): { x: number; z: number } | null {
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -(((clientY - rect.top) / rect.height) * 2 - 1);
    this.ndc.set(x, y);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.plane, hit)) return null;
    return { x: hit.x, z: hit.z };
  }

  sync(state: GameState, useGlb: boolean): void {
    this.currentState = state;
    this.useGlb = useGlb;
    this.syncWorldPlane(state);
    this.syncMapDecor(state);
    this.syncTerritory(state);
    this.syncMarkers(state);
    this.syncKeepMarker(state);
    this.syncStructures(state);
    this.syncUnits(state);
    this.syncHero(state);
    this.syncEnemyHero(state);
    this.syncHoldCubes(state);
    this.syncSelectionAndRally(state);
    this.syncCoreOrbs(state);
    this.consumeCastEvents(state);
  }

  private useGlb = false;

  private consumeCastEvents(state: GameState): void {
    const fxEvt = state.lastFx;
    if (fxEvt && fxEvt.tick !== this.lastFxTick) {
      spawnCastFx(this.fx, fxEvt.kind, { x: fxEvt.x, z: fxEvt.z });
      if (fxEvt.kind === "hero_strike") this.heroLungeTimer = 0.2;
      this.lastFxTick = fxEvt.tick;
    }
    const siege = state.lastSiegeHit;
    if (siege && siege.tick !== this.lastSiegeTick) {
      spawnSiegeTell(this.fx, { x: siege.x, z: siege.z });
      this.lastSiegeTick = siege.tick;
    }
  }

  setPlacementGhost(pos: { x: number; z: number } | null, valid: boolean): void {
    if (!pos) {
      if (this.ghost) this.ghost.visible = false;
      return;
    }
    if (!this.ghost) {
      const geo = new THREE.CylinderGeometry(2.6, 2.6, 0.3, 24);
      const mat = new THREE.MeshStandardMaterial({
        color: 0x57a8ff,
        roughness: 0.8,
        metalness: 0.05,
        transparent: true,
        opacity: 0.35,
      });
      this.ghost = new THREE.Mesh(geo, mat);
      this.ghost.position.y = 0.2;
      this.scene.add(this.ghost);
    }
    this.ghost.visible = true;
    this.ghost.position.set(pos.x, 0.2, pos.z);
    const mat = this.ghost.material as THREE.MeshStandardMaterial;
    mat.color.set(valid ? 0x57a8ff : 0xf26464);
  }

  /**
   * Ground ring + inner dot shown while dragging a command card so the player
   * can see where the spell will land (and, when relevant, the effect radius).
   * Pass `radius = null` for point-target commands; a small marker is drawn.
   */
  setCommandGhost(
    pos: { x: number; z: number } | null,
    radius: number | null,
    valid: boolean,
  ): void {
    if (!pos) {
      if (this.cmdGhost) this.cmdGhost.visible = false;
      if (this.cmdGhostCore) this.cmdGhostCore.visible = false;
      return;
    }
    if (!this.cmdGhost) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xd87bff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      this.cmdGhost = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.2, 48), mat);
      this.cmdGhost.rotation.x = -Math.PI / 2;
      this.cmdGhost.position.y = 0.08;
      this.scene.add(this.cmdGhost);
    }
    if (!this.cmdGhostCore) {
      const coreMat = new THREE.MeshBasicMaterial({
        color: 0xf0c8ff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.75,
        depthWrite: false,
      });
      this.cmdGhostCore = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.9, 32), coreMat);
      this.cmdGhostCore.rotation.x = -Math.PI / 2;
      this.cmdGhostCore.position.y = 0.09;
      this.scene.add(this.cmdGhostCore);
    }

    const r = Math.max(1, radius ?? 1.5);
    this.cmdGhost.geometry.dispose();
    this.cmdGhost.geometry = new THREE.RingGeometry(Math.max(0.1, r - 0.3), r, 64);
    this.cmdGhost.position.set(pos.x, 0.08, pos.z);
    this.cmdGhost.visible = true;
    (this.cmdGhost.material as THREE.MeshBasicMaterial).color.set(valid ? 0xd87bff : 0xff6a6a);

    this.cmdGhostCore.position.set(pos.x, 0.09, pos.z);
    this.cmdGhostCore.visible = true;
    (this.cmdGhostCore.material as THREE.MeshBasicMaterial).color.set(
      valid ? 0xf0c8ff : 0xffb3b3,
    );
  }

  private syncTaps(state: GameState): void {
    const hero = state.hero;

    // Find the nearest neutral tap to the hero — we highlight it with an
    // extra pulsing ring so the player always has an obvious "go here next".
    let nearestId: string | null = null;
    {
      let bestD = Infinity;
      for (const t of state.taps) {
        if (t.active) continue;
        const dx = t.x - hero.x;
        const dz = t.z - hero.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD) {
          bestD = d2;
          nearestId = t.defId;
        }
      }
    }

    for (let idx = 0; idx < state.taps.length; idx++) {
      const t = state.taps[idx]!;
      let m = this.tapMeshes.get(t.defId);
      if (!m) {
        const geo = new THREE.RingGeometry(2.2, 3.2, 32);
        const mat = new THREE.MeshBasicMaterial({
          color: 0x666666,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.9,
        });
        m = new THREE.Mesh(geo, mat);
        m.rotation.x = -Math.PI / 2;
        m.position.y = 0.05;
        this.markers.add(m);
        this.tapMeshes.set(t.defId, m);
      }
      m.position.set(t.x, 0.05, t.z);
      const mat = m.material as THREE.MeshBasicMaterial;
      if (t.active && t.ownerTeam === "player") mat.color.set(0x5fc48a);
      else if (t.active && t.ownerTeam === "enemy") mat.color.set(0xd06060);
      else if (t.active && t.yieldRemaining <= 0) mat.color.set(0x888888);
      else if (t.active) mat.color.set(0x3ecf8e);
      else mat.color.set(0x8a96a6);

      // Claim channel arc (cyan), visible while hero is channeling this tap.
      let claimArc = this.tapClaimArcs.get(t.defId);
      const channeling = hero.claimChannelTarget === idx || state.enemyHero.claimChannelTarget === idx;
      if (channeling) {
        const total = Math.max(1, Math.round(HERO_CLAIM_CHANNEL_SEC * TICK_HZ));
        const isEnemyChannel = state.enemyHero.claimChannelTarget === idx;
        const frac = isEnemyChannel
          ? Math.max(0, Math.min(1, 1 - state.enemyHero.claimChannelTicksRemaining / total))
          : Math.max(0, Math.min(1, 1 - hero.claimChannelTicksRemaining / total));
        if (!claimArc) {
          claimArc = new THREE.Mesh(
            new THREE.RingGeometry(3.4, 3.9, 48, 1, 0, 0.0001),
            new THREE.MeshBasicMaterial({
              color: state.enemyHero.claimChannelTarget === idx ? 0xff8a8a : 0x6ae1ff,
              side: THREE.DoubleSide,
              transparent: true,
              opacity: 0.95,
              depthWrite: false,
            }),
          );
          claimArc.rotation.x = -Math.PI / 2;
          claimArc.position.y = 0.07;
          this.markers.add(claimArc);
          this.tapClaimArcs.set(t.defId, claimArc);
        }
        claimArc.position.set(t.x, 0.07, t.z);
        claimArc.geometry.dispose();
        claimArc.geometry = new THREE.RingGeometry(
          3.4,
          3.9,
          48,
          1,
          -Math.PI / 2,
          Math.max(0.0001, frac * Math.PI * 2),
        );
        claimArc.visible = true;
        (claimArc.material as THREE.MeshBasicMaterial).color.set(isEnemyChannel ? 0xff8a8a : 0x6ae1ff);
      } else if (claimArc) {
        claimArc.visible = false;
      }

      // Floating label: "Stand to claim — 20 Mana" on unclaimed taps, "Depleted"
      // on dried-up ones. Hidden once the player owns the tap.
      let label = this.tapLabels.get(t.defId);
      const claimedByPlayer = t.active && t.ownerTeam === "player";
      const claimedByEnemy = t.active && t.ownerTeam === "enemy";
      const depleted = t.active && t.yieldRemaining <= 0;
      if (!claimedByPlayer && !claimedByEnemy) {
        if (!label) {
          label = makeLabelSprite("Stand to claim", "#6ae1ff");
          this.markers.add(label.sprite);
          this.tapLabels.set(t.defId, label);
        }
        const text = depleted ? "Depleted" : "Stand to claim";
        const accent = depleted ? "#8a96a6" : "#6ae1ff";
        drawLabel(label, text, accent);
        label.sprite.position.set(t.x, 4.2, t.z);
        label.sprite.visible = true;
        (label.sprite.material as THREE.SpriteMaterial).opacity = depleted ? 0.55 : 1;
      } else if (label) {
        label.sprite.visible = false;
      }

      let arc = this.tapYieldArcs.get(t.defId);
      const active = t.active && t.yieldRemaining > 0;
      if (active) {
        const frac = Math.max(0, Math.min(1, t.yieldRemaining / TAP_YIELD_MAX));
        if (!arc) {
          arc = new THREE.Mesh(
            new THREE.RingGeometry(1.3, 2.0, 48, 1, 0, Math.PI * 2),
            new THREE.MeshBasicMaterial({
              color: 0x7cf0b4,
              side: THREE.DoubleSide,
              transparent: true,
              opacity: 0.9,
              depthWrite: false,
            }),
          );
          arc.rotation.x = -Math.PI / 2;
          arc.position.y = 0.07;
          this.markers.add(arc);
          this.tapYieldArcs.set(t.defId, arc);
        }
        arc.position.set(t.x, 0.07, t.z);
        arc.geometry.dispose();
        arc.geometry = new THREE.RingGeometry(
          1.3,
          2.0,
          48,
          1,
          Math.PI / 2 - frac * Math.PI,
          Math.max(0.0001, frac * Math.PI * 2),
        );
        (arc.material as THREE.MeshBasicMaterial).color.set(
          t.ownerTeam === "enemy" ? 0xff7070 : 0x7cf0b4,
        );
        arc.visible = true;
      } else if (arc) {
        arc.visible = false;
      }
    }

    // Pulsing "next target" ring sitting just outside the tap ring.
    if (nearestId !== null) {
      const t = state.taps.find((x) => x.defId === nearestId)!;
      if (!this.nearestTapRing) {
        this.nearestTapRing = new THREE.Mesh(
          new THREE.RingGeometry(3.5, 4.1, 48),
          new THREE.MeshBasicMaterial({
            color: 0x6ae1ff,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.85,
            depthWrite: false,
          }),
        );
        this.nearestTapRing.rotation.x = -Math.PI / 2;
        this.markers.add(this.nearestTapRing);
      }
      const elapsed = this.clock.getElapsedTime();
      const pulse = 0.5 + 0.5 * Math.sin(elapsed * 3.2);
      this.nearestTapRing.position.set(t.x, 0.06, t.z);
      const s = 1 + pulse * 0.18;
      this.nearestTapRing.scale.set(s, s, s);
      (this.nearestTapRing.material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.4 * pulse;
      this.nearestTapRing.visible = true;
    } else if (this.nearestTapRing) {
      this.nearestTapRing.visible = false;
    }
  }

  private syncMarkers(state: GameState): void {
    this.syncTaps(state);
    this.syncCampZones(state);

    // Only enemy relays (Dark Fortresses) render as markers now — the player's
    // Keep is just a structure and renders through syncStructures().
    const aliveRelayIds = new Set(state.enemyRelays.map((er) => `e:${er.defId}`));
    for (const [id, m] of this.relayMeshes) {
      if (!aliveRelayIds.has(id)) {
        this.markers.remove(m);
        this.disposeObject(m);
        this.relayMeshes.delete(id);
        this.relayPrevHp.delete(id);
      }
    }
    for (const er of state.enemyRelays) {
      const id = `e:${er.defId}`;
      let m = this.relayMeshes.get(id);
      if (!m) {
        const geo = new THREE.CylinderGeometry(1.2, 1.4, 2.4, 16);
        const mat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.8 });
        m = new THREE.Mesh(geo, mat);
        m.position.y = 1.2;
        m.castShadow = true;
        m.receiveShadow = true;
        m.userData["bodyMesh"] = m;
        this.markers.add(m);
        this.relayMeshes.set(id, m);
      }
      m.position.set(er.x, 1.2, er.z);
      const mat = m.material as THREE.MeshStandardMaterial;
      const built = er.hp > 0;
      if (built) {
        const silenced = er.silencedUntilTick > state.tick;
        const base = new THREE.Color(0xff5c5c);
        if (silenced) base.multiplyScalar(0.45);
        mat.color.copy(base);
      } else {
        mat.color.set(0x444444);
      }
      const s = built ? 1 : 0.55;
      m.scale.set(s, s, s);
      const pair = this.ensureHpBarPair(m, "relay", 1.95, 0xff7a6a);
      this.setHpBarFrac(pair, er.maxHp > 0 ? Math.max(0, er.hp / er.maxHp) : 0);
      const prevHp = this.relayPrevHp.get(id);
      if (prevHp !== undefined && er.hp < prevHp - 0.5) {
        (m.userData as Record<string, unknown>)["hitPulse"] = 0.22;
      }
      this.relayPrevHp.set(id, er.hp);
    }
  }

  private syncCampZones(state: GameState): void {
    const alive = new Set(state.map.enemyCamps.map((c) => c.id));
    for (const [id, ring] of this.campAggroRings) {
      if (!alive.has(id)) {
        this.markers.remove(ring);
        this.disposeObject(ring);
        this.campAggroRings.delete(id);
      }
    }
    for (const [id, ring] of this.campWakeRings) {
      if (!alive.has(id)) {
        this.markers.remove(ring);
        this.disposeObject(ring);
        this.campWakeRings.delete(id);
      }
    }
    for (const camp of state.map.enemyCamps) {
      let aggro = this.campAggroRings.get(camp.id);
      if (!aggro) {
        aggro = new THREE.Mesh(
          new THREE.RingGeometry(Math.max(0.1, camp.aggroRadius - 0.3), camp.aggroRadius, 64),
          new THREE.MeshBasicMaterial({
            color: 0xff6a6a,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.22,
            depthWrite: false,
          }),
        );
        aggro.rotation.x = -Math.PI / 2;
        this.markers.add(aggro);
        this.campAggroRings.set(camp.id, aggro);
      }
      aggro.position.set(camp.origin.x, 0.045, camp.origin.z);
      aggro.visible = true;

      let wake = this.campWakeRings.get(camp.id);
      if (!wake) {
        wake = new THREE.Mesh(
          new THREE.RingGeometry(Math.max(0.1, camp.wakeRadius - 0.2), camp.wakeRadius, 80),
          new THREE.MeshBasicMaterial({
            color: 0xffb3a3,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.1,
            depthWrite: false,
          }),
        );
        wake.rotation.x = -Math.PI / 2;
        this.markers.add(wake);
        this.campWakeRings.set(camp.id, wake);
      }
      wake.position.set(camp.origin.x, 0.04, camp.origin.z);
      wake.visible = true;
    }
  }

  private disposeObject(obj: THREE.Object3D): void {
    obj.traverse((c) => {
      if (c instanceof THREE.Mesh) {
        c.geometry.dispose();
        if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose());
        else c.material.dispose();
      }
    });
  }

  private syncKeepMarker(state: GameState): void {
    const keep = findKeep(state);
    if (!keep) {
      if (this.keepRing) this.keepRing.visible = false;
      if (this.keepHpArc) this.keepHpArc.visible = false;
      return;
    }
    if (!this.keepRing) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(3.6, 4.4, 56),
        new THREE.MeshBasicMaterial({
          color: 0xb58bff,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.6,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      this.markers.add(ring);
      this.keepRing = ring;
    }
    const frac = Math.max(0, Math.min(1, keep.maxHp > 0 ? keep.hp / keep.maxHp : 0));
    if (!this.keepHpArc) {
      const arc = new THREE.Mesh(
        new THREE.RingGeometry(4.5, 4.9, 64, 1, 0, Math.PI * 2),
        new THREE.MeshBasicMaterial({
          color: 0xd9b7ff,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
        }),
      );
      arc.rotation.x = -Math.PI / 2;
      this.markers.add(arc);
      this.keepHpArc = arc;
    }
    const pulse = 0.5 + 0.5 * Math.sin(this.clock.getElapsedTime() * 1.6);
    this.keepRing.position.set(keep.x, 0.06, keep.z);
    (this.keepRing.material as THREE.MeshBasicMaterial).opacity = 0.38 + 0.35 * pulse;
    this.keepRing.visible = true;

    this.keepHpArc.position.set(keep.x, 0.065, keep.z);
    this.keepHpArc.geometry.dispose();
    this.keepHpArc.geometry = new THREE.RingGeometry(
      4.5,
      4.9,
      64,
      1,
      Math.PI / 2 - frac * Math.PI,
      Math.max(0.0001, frac * Math.PI * 2),
    );
    const arcMat = this.keepHpArc.material as THREE.MeshBasicMaterial;
    if (frac < 0.35) arcMat.color.set(0xff7474);
    else if (frac < 0.7) arcMat.color.set(0xffd08a);
    else arcMat.color.set(0xd9b7ff);
    this.keepHpArc.visible = true;
  }

  private syncStructures(state: GameState): void {
    const alive = new Set(state.structures.map((s) => s.id));
    for (const [id, obj] of this.structureMeshes) {
      if (!alive.has(id)) {
        this.entities.remove(obj);
        this.disposeObject(obj);
        this.structureMeshes.delete(id);
      }
    }

    for (const st of state.structures) {
      let obj = this.structureMeshes.get(st.id);
      const entry = getCatalogEntry(st.catalogId);
      const structEntry = entry && isStructureEntry(entry) ? entry : null;
      if (!obj) {
        if (!structEntry) continue;
        const g = buildStructureSilhouette(structEntry, st.team);
        obj = g;
        this.entities.add(g);
        this.structureMeshes.set(st.id, g);
        if (this.useGlb) {
          const ph = g.userData["bodyMesh"] as THREE.Mesh | undefined;
          if (ph) void requestGlbForTower(st.catalogId, ph);
        }
      }
      const g = obj as THREE.Group;
      g.position.set(st.x, 0, st.z);
      const buildT = st.complete ? 1 : 0.35 + 0.65 * (1 - st.buildTicksRemaining / Math.max(1, st.buildTotalTicks));
      g.scale.set(1, buildT, 1);

      g.traverse((c) => {
        if (c instanceof THREE.Mesh) {
          if (c.userData["skipBuildOpacity"] || c.userData["isPlaceholder"]) return;
          const mat = c.material as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial | undefined;
          if (!mat || !("opacity" in mat)) return;
          if (mat.userData["baseOpacity"] === undefined) mat.userData["baseOpacity"] = mat.opacity;
          mat.transparent = true;
          mat.opacity = st.complete ? (mat.userData["baseOpacity"] as number | undefined) ?? 1 : 0.55;
        }
      });

      const dims = structEntry ? structureDims(structEntry) : { w: 3, h: 5, d: 3 };
      const fg = st.team === "player" ? 0x7ec8ff : 0xff8a7a;
      const pair = this.ensureHpBarPair(g, "st", dims.h * buildT + 0.9, fg);
      this.setHpBarFrac(pair, st.maxHp > 0 ? st.hp / st.maxHp : 0);
      const prevHp = this.structurePrevHp.get(st.id);
      if (prevHp !== undefined && st.hp < prevHp - 0.25) {
        (g.userData as Record<string, unknown>)["hitPulse"] = 0.22;
      }
      this.structurePrevHp.set(st.id, st.hp);
    }
  }

  private syncHoldCubes(state: GameState): void {
    const alive = new Set(state.structures.map((s) => s.id));
    for (const [id, cube] of this.holdCubes) {
      if (!alive.has(id)) {
        this.markers.remove(cube);
        this.disposeObject(cube);
        this.holdCubes.delete(id);
      }
    }
    const elapsed = this.clock.getElapsedTime();
    for (const st of state.structures) {
      let cube = this.holdCubes.get(st.id);
      const show = st.team === "player" && st.holdOrders && st.complete;
      if (show) {
        if (!cube) {
          cube = new THREE.Mesh(
            new THREE.BoxGeometry(0.7, 0.7, 0.7),
            new THREE.MeshStandardMaterial({
              color: 0xff5050,
              emissive: 0x441010,
              roughness: 0.4,
            }),
          );
          this.markers.add(cube);
          this.holdCubes.set(st.id, cube);
        }
        const entry = getCatalogEntry(st.catalogId);
        const dims = entry && isStructureEntry(entry) ? structureDims(entry) : { w: 3, h: 5, d: 3 };
        const hover = 0.2 * Math.sin(elapsed * 3);
        cube.position.set(st.x, dims.h + 1.4 + hover, st.z);
        cube.rotation.y = elapsed * 0.9;
        cube.visible = true;
      } else if (cube) {
        cube.visible = false;
      }
    }
  }

  private syncSelectionAndRally(state: GameState): void {
    const selId = state.selectedStructureId;
    const st = selId !== null ? state.structures.find((x) => x.id === selId) : null;

    if (st && st.team === "player") {
      if (!this.selectHalo) {
        this.selectHalo = new THREE.Mesh(
          new THREE.RingGeometry(2.8, 3.4, 48),
          new THREE.MeshBasicMaterial({
            color: 0x62b6ff,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.75,
            depthWrite: false,
          }),
        );
        this.selectHalo.rotation.x = -Math.PI / 2;
        this.markers.add(this.selectHalo);
      }
      this.selectHalo.position.set(st.x, 0.04, st.z);
      this.selectHalo.visible = true;
      const entry = getCatalogEntry(st.catalogId);
      const structEntry = entry && isStructureEntry(entry) ? entry : null;
      if (structEntry) {
        const attackRange = unitStatsForCatalog(structEntry.producedSizeClass).range;
        if (!this.attackRangeRing) {
          this.attackRangeRing = new THREE.Mesh(
            new THREE.RingGeometry(Math.max(0.2, attackRange - 0.15), attackRange, 56),
            new THREE.MeshBasicMaterial({
              color: 0x7ec8ff,
              side: THREE.DoubleSide,
              transparent: true,
              opacity: 0.28,
              depthWrite: false,
            }),
          );
          this.attackRangeRing.rotation.x = -Math.PI / 2;
          this.markers.add(this.attackRangeRing);
        }
        this.attackRangeRing.geometry.dispose();
        this.attackRangeRing.geometry = new THREE.RingGeometry(
          Math.max(0.2, attackRange - 0.15),
          attackRange,
          56,
        );
        this.attackRangeRing.position.set(st.x, 0.05, st.z);
        this.attackRangeRing.visible = true;

        if (structEntry.aura && structEntry.aura.radius > 0) {
          if (!this.auraRangeRing) {
            this.auraRangeRing = new THREE.Mesh(
              new THREE.RingGeometry(1.5, 1.8, 56),
              new THREE.MeshBasicMaterial({
                color: 0x6affc7,
                side: THREE.DoubleSide,
                transparent: true,
                opacity: 0.24,
                depthWrite: false,
              }),
            );
            this.auraRangeRing.rotation.x = -Math.PI / 2;
            this.markers.add(this.auraRangeRing);
          }
          this.auraRangeRing.geometry.dispose();
          this.auraRangeRing.geometry = new THREE.RingGeometry(
            Math.max(0.2, structEntry.aura.radius - 0.2),
            structEntry.aura.radius,
            64,
          );
          this.auraRangeRing.position.set(st.x, 0.055, st.z);
          this.auraRangeRing.visible = true;
        } else if (this.auraRangeRing) {
          this.auraRangeRing.visible = false;
        }
      } else {
        if (this.attackRangeRing) this.attackRangeRing.visible = false;
        if (this.auraRangeRing) this.auraRangeRing.visible = false;
      }

      if (!st.holdOrders && (st.rallyX !== st.x || st.rallyZ !== st.z)) {
        if (!this.rallyLine) {
          const geo = new THREE.BufferGeometry();
          geo.setAttribute(
            "position",
            new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3),
          );
          this.rallyLine = new THREE.Line(
            geo,
            new THREE.LineBasicMaterial({
              color: 0x6ae1ff,
              transparent: true,
              opacity: 0.85,
            }),
          );
          this.markers.add(this.rallyLine);
        }
        const pos = this.rallyLine.geometry.getAttribute("position") as THREE.BufferAttribute;
        pos.setXYZ(0, st.x, 0.12, st.z);
        pos.setXYZ(1, st.rallyX, 0.12, st.rallyZ);
        pos.needsUpdate = true;
        this.rallyLine.visible = true;

        if (!this.rallyFlag) {
          this.rallyFlag = new THREE.Mesh(
            new THREE.ConeGeometry(0.35, 1.1, 10),
            new THREE.MeshStandardMaterial({
              color: 0x6ae1ff,
              emissive: 0x234a66,
              roughness: 0.45,
            }),
          );
          this.markers.add(this.rallyFlag);
        }
        this.rallyFlag.position.set(st.rallyX, 0.55, st.rallyZ);
        this.rallyFlag.rotation.y = this.clock.getElapsedTime() * 1.4;
        this.rallyFlag.visible = true;
      } else {
        if (this.rallyLine) this.rallyLine.visible = false;
        if (this.rallyFlag) this.rallyFlag.visible = false;
      }
    } else {
      if (this.selectHalo) this.selectHalo.visible = false;
      if (this.attackRangeRing) this.attackRangeRing.visible = false;
      if (this.auraRangeRing) this.auraRangeRing.visible = false;
      if (this.rallyLine) this.rallyLine.visible = false;
      if (this.rallyFlag) this.rallyFlag.visible = false;
    }
  }

  private syncWorldPlane(state: GameState): void {
    const half = state.map.world.halfExtents + 28;
    if (this.worldPlaneHalf === half) return;
    this.worldPlaneHalf = half;
    const size = half * 2;
    this.ground.geometry.dispose();
    this.ground.geometry = new THREE.PlaneGeometry(size, size);
    this.scene.remove(this.grid);
    this.grid.dispose();
    const divs = Math.max(24, Math.round(size / 6));
    this.grid = new THREE.GridHelper(size * 0.96, divs, 0x2a3545, 0x1f2937);
    this.grid.position.y = 0.02;
    this.scene.add(this.grid);
  }

  private ensureHpBarPair(
    parent: THREE.Object3D,
    key: string,
    yLocal: number,
    fgColor: number,
  ): { bg: THREE.Mesh; fg: THREE.Mesh } {
    const ud = parent.userData as Record<string, unknown>;
    let bg = ud[`${key}_hpBg`] as THREE.Mesh | undefined;
    let fg = ud[`${key}_hpFg`] as THREE.Mesh | undefined;
    if (!bg) {
      bg = new THREE.Mesh(
        new THREE.PlaneGeometry(1.35, 0.12),
        new THREE.MeshBasicMaterial({
          color: 0x1a1f28,
          transparent: true,
          opacity: 0.88,
          depthWrite: false,
        }),
      );
      bg.position.y = yLocal;
      parent.add(bg);
      ud[`${key}_hpBg`] = bg;
    }
    if (!fg) {
      fg = new THREE.Mesh(
        new THREE.PlaneGeometry(1.32, 0.09),
        new THREE.MeshBasicMaterial({
          color: fgColor,
          transparent: true,
          opacity: 0.95,
          depthWrite: false,
        }),
      );
      fg.position.y = yLocal;
      fg.position.z = 0.003;
      parent.add(fg);
      ud[`${key}_hpFg`] = fg;
    }
    return { bg: bg!, fg: fg! };
  }

  private setHpBarFrac(pair: { bg: THREE.Mesh; fg: THREE.Mesh }, frac01: number): void {
    const frac = Math.max(0, Math.min(1, frac01));
    pair.fg.scale.x = Math.max(0.02, frac);
    pair.fg.position.x = -0.66 * (1 - frac);
  }

  private syncMapDecor(state: GameState): void {
    if (this.decorBuilt) return;
    this.decorBuilt = true;
    for (const d of state.map.decor ?? []) {
      let mesh: THREE.Mesh | null = null;
      if (d.kind === "box") {
        mesh = new THREE.Mesh(
          new THREE.BoxGeometry(d.w, d.h, d.d),
          new THREE.MeshStandardMaterial({
            color: d.color ?? 0x3a4657,
            roughness: 0.9,
            metalness: 0.04,
          }),
        );
        mesh.position.set(d.x, d.h / 2, d.z);
        mesh.rotation.y = ((d.rotYDeg ?? 0) * Math.PI) / 180;
      } else if (d.kind === "cylinder") {
        mesh = new THREE.Mesh(
          new THREE.CylinderGeometry(d.radius, d.radius, d.h, 18),
          new THREE.MeshStandardMaterial({
            color: d.color ?? 0x4a4d5f,
            roughness: 0.85,
            metalness: 0.05,
          }),
        );
        mesh.position.set(d.x, d.h / 2, d.z);
      }
      if (!mesh) continue;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.decor.add(mesh);
    }
  }

  private syncCoreOrbs(state: GameState): void {
    const alive = new Set<string>();
    for (const campId of Object.keys(state.enemyCampCoreHp)) alive.add(campId);
    for (const [id, orb] of this.coreOrbs) {
      if (!alive.has(id)) {
        this.markers.remove(orb);
        this.disposeObject(orb);
        this.coreOrbs.delete(id);
      }
    }
    const elapsed = this.clock.getElapsedTime();
    for (const campId of alive) {
      const camp = state.map.enemyCamps.find((c) => c.id === campId);
      if (!camp) continue;
      const hp = state.enemyCampCoreHp[campId] ?? 0;
      const maxHp = camp.coreMaxHp ?? 0;
      if (maxHp <= 0) continue;
      const frac = Math.max(0, Math.min(1, hp / maxHp));
      let orb = this.coreOrbs.get(campId);
      if (!orb) {
        orb = new THREE.Mesh(
          new THREE.SphereGeometry(1, 18, 14),
          new THREE.MeshStandardMaterial({
            color: 0xff5544,
            emissive: 0x550000,
            emissiveIntensity: 0.7,
            roughness: 0.35,
            metalness: 0.1,
            transparent: true,
            opacity: 0.9,
          }),
        );
        this.markers.add(orb);
        this.coreOrbs.set(campId, orb);
      }
      const breathe = 0.08 * Math.sin(elapsed * 2.4);
      const r = 0.8 + frac * 1.8 + breathe;
      orb.scale.setScalar(r);
      orb.position.set(camp.origin.x, 2.4 + breathe, camp.origin.z);
      const mat = orb.material as THREE.MeshStandardMaterial;
      mat.opacity = 0.45 + 0.5 * frac;
      mat.emissiveIntensity = 0.4 + 0.8 * frac;
    }
  }

  private syncTerritory(state: GameState): void {
    const sources = territorySources(state);
    const key = sources.map((p) => `${p.x.toFixed(1)},${p.z.toFixed(1)}`).join("|");
    if (key === this.territoryKey && this.territoryMeshes.length === sources.length) return;
    this.territoryKey = key;
    for (const m of this.territoryMeshes) {
      this.territoryGroup.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.territoryMeshes = [];
    if (sources.length === 0) return;
    const geo = new THREE.RingGeometry(0, TERRITORY_RADIUS, 48);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x6ae1ff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.08,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    for (const p of sources) {
      const m = new THREE.Mesh(geo.clone(), mat.clone());
      m.rotation.x = -Math.PI / 2;
      m.position.set(p.x, 0.06, p.z);
      this.territoryGroup.add(m);
      this.territoryMeshes.push(m);
    }
    mat.dispose();
    geo.dispose();
  }

  private buildHeroMesh(): THREE.Group {
    const g = new THREE.Group();
    // Team plinth (blue).
    const plinth = new THREE.Mesh(
      new THREE.CylinderGeometry(1.2, 1.3, 0.22, 28),
      new THREE.MeshStandardMaterial({
        color: 0x2a5c8a,
        roughness: 0.85,
        transparent: true,
        opacity: 0.95,
      }),
    );
    plinth.position.y = 0.11;
    plinth.receiveShadow = true;
    g.add(plinth);

    // Placeholder body (will be hidden when GLB loads).
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.75, 1.7, 14),
      new THREE.MeshStandardMaterial({ color: 0x4da3ff, roughness: 0.55, metalness: 0.2, emissive: 0x0a2030 }),
    );
    body.position.y = 0.95;
    body.castShadow = true;
    body.userData["isPlaceholder"] = true;
    g.add(body);
    (g.userData as Record<string, unknown>)["bodyMesh"] = body;

    // Bright cyan rim ring so hero is always visually findable.
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.15, 32),
      new THREE.MeshBasicMaterial({
        color: 0x6ae1ff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04;
    g.add(ring);

    return g;
  }

  private buildRivalHeroMesh(): THREE.Group {
    const g = new THREE.Group();
    const plinth = new THREE.Mesh(
      new THREE.CylinderGeometry(1.2, 1.3, 0.22, 28),
      new THREE.MeshStandardMaterial({
        color: 0x6a2a2a,
        roughness: 0.85,
        transparent: true,
        opacity: 0.95,
      }),
    );
    plinth.position.y = 0.11;
    plinth.receiveShadow = true;
    g.add(plinth);

    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.75, 1.7, 14),
      new THREE.MeshStandardMaterial({
        color: 0xc44a4a,
        roughness: 0.55,
        metalness: 0.2,
        emissive: 0x300808,
      }),
    );
    body.position.y = 0.95;
    body.castShadow = true;
    body.userData["isPlaceholder"] = true;
    g.add(body);
    (g.userData as Record<string, unknown>)["bodyMesh"] = body;

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.15, 32),
      new THREE.MeshBasicMaterial({
        color: 0xff6a6a,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04;
    g.add(ring);

    return g;
  }

  private syncHero(state: GameState): void {
    const h = state.hero;
    if (!this.heroGroup) {
      const g = this.buildHeroMesh();
      this.entities.add(g);
      this.heroGroup = g;
      if (this.useGlb) {
        const placeholder = (g.userData["bodyMesh"] as THREE.Mesh | undefined) ?? null;
        if (placeholder) void requestGlbForHero(placeholder);
      }
    }
    this.heroGroup.position.set(h.x, 0, h.z);
    this.heroGroup.rotation.y = h.facing;
    if (this.heroLungeTimer > 0) {
      const p = this.heroLungeTimer / 0.2;
      const amt = 0.38 * Math.sin(p * Math.PI);
      this.heroGroup.position.x += Math.sin(h.facing) * amt;
      this.heroGroup.position.z += Math.cos(h.facing) * amt;
    }

    // HP bar (two thin planes floating above).
    if (!this.heroHpBarBg) {
      const bg = new THREE.Mesh(
        new THREE.PlaneGeometry(1.8, 0.16),
        new THREE.MeshBasicMaterial({ color: 0x202632, transparent: true, opacity: 0.85, depthWrite: false }),
      );
      bg.position.y = 2.85;
      this.heroGroup.add(bg);
      this.heroHpBarBg = bg;
    }
    if (!this.heroHpBarFg) {
      const fg = new THREE.Mesh(
        new THREE.PlaneGeometry(1.76, 0.12),
        new THREE.MeshBasicMaterial({ color: 0x6ae1ff, transparent: true, opacity: 0.95, depthWrite: false }),
      );
      fg.position.y = 2.85;
      fg.position.z = 0.002;
      this.heroGroup.add(fg);
      this.heroHpBarFg = fg;
    }
    const frac = Math.max(0, Math.min(1, h.maxHp > 0 ? h.hp / h.maxHp : 0));
    this.heroHpBarFg.scale.x = Math.max(0.0001, frac);
    this.heroHpBarFg.position.x = -0.88 * (1 - frac);
  }

  private syncEnemyHero(state: GameState): void {
    const h = state.enemyHero;
    if (!this.enemyHeroGroup) {
      const g = this.buildRivalHeroMesh();
      this.entities.add(g);
      this.enemyHeroGroup = g;
      if (this.useGlb) {
        const placeholder = (g.userData["bodyMesh"] as THREE.Mesh | undefined) ?? null;
        if (placeholder) void requestGlbForHero(placeholder);
      }
    }
    this.enemyHeroGroup.visible = h.hp > 0;
    if (h.hp <= 0) return;
    this.enemyHeroGroup.position.set(h.x, 0, h.z);
    this.enemyHeroGroup.rotation.y = h.facing;

    if (!this.enemyHeroHpBarBg) {
      const bg = new THREE.Mesh(
        new THREE.PlaneGeometry(1.8, 0.16),
        new THREE.MeshBasicMaterial({ color: 0x202632, transparent: true, opacity: 0.85, depthWrite: false }),
      );
      bg.position.y = 2.85;
      this.enemyHeroGroup.add(bg);
      this.enemyHeroHpBarBg = bg;
    }
    if (!this.enemyHeroHpBarFg) {
      const fg = new THREE.Mesh(
        new THREE.PlaneGeometry(1.76, 0.12),
        new THREE.MeshBasicMaterial({ color: 0xff7a7a, transparent: true, opacity: 0.95, depthWrite: false }),
      );
      fg.position.y = 2.85;
      fg.position.z = 0.002;
      this.enemyHeroGroup.add(fg);
      this.enemyHeroHpBarFg = fg;
    }
    const frac = Math.max(0, Math.min(1, h.maxHp > 0 ? h.hp / h.maxHp : 0));
    this.enemyHeroHpBarFg.scale.x = Math.max(0.0001, frac);
    this.enemyHeroHpBarFg.position.x = -0.88 * (1 - frac);
  }

  private syncUnits(state: GameState): void {
    const alive = new Set(state.units.map((u) => u.id));
    for (const [id, obj] of this.unitMeshes) {
      if (!alive.has(id)) {
        this.entities.remove(obj);
        this.disposeObject(obj);
        this.unitMeshes.delete(id);
      }
    }

    for (const u of state.units) {
      let obj = this.unitMeshes.get(u.id);
      if (!obj) {
        const g = buildUnitMesh(u.signal, u.team, u.sizeClass);
        this.entities.add(g);
        this.unitMeshes.set(u.id, g);
        obj = g;
        if (this.useGlb) {
          const placeholder = (g.userData["bodyMesh"] as THREE.Mesh | undefined) ?? null;
          if (placeholder) {
            void requestGlbForUnit(u.sizeClass, placeholder);
          }
        }
      }
      obj.position.set(u.x, 0, u.z);
      const g = obj as THREE.Group;
      const h = unitScale(u.sizeClass) * 1.35;
      const fg = u.team === "player" ? 0x7ec8ff : 0xff8888;
      const pair = this.ensureHpBarPair(g, "u", h, fg);
      this.setHpBarFrac(pair, u.maxHp > 0 ? u.hp / u.maxHp : 0);
      const prevHp = this.unitPrevHp.get(u.id);
      if (prevHp !== undefined && u.hp < prevHp - 0.25) {
        (g.userData as Record<string, unknown>)["hitPulse"] = 0.22;
      }
      this.unitPrevHp.set(u.id, u.hp);
    }
  }

  private orientHpBars(): void {
    const cam = this.camera.position;
    const orient = (root: THREE.Object3D): void => {
      const ud = root.userData as Record<string, unknown>;
      for (const key of ["u", "st", "relay"] as const) {
        const bg = ud[`${key}_hpBg`] as THREE.Mesh | undefined;
        const fg = ud[`${key}_hpFg`] as THREE.Mesh | undefined;
        if (bg) bg.lookAt(cam);
        if (fg) fg.lookAt(cam);
      }
    };
    for (const g of this.unitMeshes.values()) orient(g);
    for (const g of this.structureMeshes.values()) orient(g);
    for (const m of this.relayMeshes.values()) orient(m);
    if (this.heroGroup && this.heroHpBarBg && this.heroHpBarFg) {
      this.heroHpBarBg.lookAt(cam);
      this.heroHpBarFg.lookAt(cam);
    }
    if (this.enemyHeroGroup && this.enemyHeroHpBarBg && this.enemyHeroHpBarFg) {
      this.enemyHeroHpBarBg.lookAt(cam);
      this.enemyHeroHpBarFg.lookAt(cam);
    }
  }

  private tickHitPulses(dt: number): void {
    const pulse = (root: THREE.Object3D): void => {
      const ud = root.userData as Record<string, unknown>;
      const t = ud["hitPulse"] as number | undefined;
      if (t === undefined || t <= 0) return;
      const next = t - dt;
      const body = ud["bodyMesh"] as THREE.Mesh | undefined;
      if (next <= 0) {
        ud["hitPulse"] = undefined;
        if (body) body.scale.setScalar(1);
        return;
      }
      ud["hitPulse"] = next;
      const k = 1 + 0.12 * Math.sin((next / 0.22) * Math.PI);
      if (body) body.scale.setScalar(k);
    };
    for (const g of this.unitMeshes.values()) pulse(g);
    for (const g of this.structureMeshes.values()) pulse(g);
    for (const m of this.relayMeshes.values()) pulse(m);
    if (this.enemyHeroGroup) pulse(this.enemyHeroGroup);
  }

  render(): void {
    const dt = Math.min(0.1, this.clock.getDelta());
    this.controls.update();
    this.tickHitPulses(dt);
    this.orientHpBars();
    stepFx(this.fx, dt);
    // Re-run selection/rally pose updates on the flag so it keeps rotating between sim ticks.
    if (this.currentState && this.rallyFlag?.visible) {
      this.rallyFlag.rotation.y = this.clock.getElapsedTime() * 1.4;
    }
    this.renderer.render(this.scene, this.camera);
    this.heroLungeTimer = Math.max(0, this.heroLungeTimer - dt);
  }
}
