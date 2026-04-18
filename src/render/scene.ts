import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { getCatalogEntry } from "../game/catalog";
import { HERO_CLAIM_CHANNEL_SEC, TAP_YIELD_MAX, TERRITORY_RADIUS, TICK_HZ } from "../game/constants";
import { unitStatsForCatalog } from "../game/sim/systems/helpers";
import {
  dominantSignal,
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
  private readonly grid: THREE.GridHelper;
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
  private territoryGroup = new THREE.Group();
  private territoryMeshes: THREE.Mesh[] = [];
  private territoryKey = "";
  private heroGroup: THREE.Group | null = null;
  private heroHpBarBg: THREE.Mesh | null = null;
  private heroHpBarFg: THREE.Mesh | null = null;
  private relayMeshes = new Map<string, THREE.Mesh>();
  /** Per player-relay slot: cyan pulsing ring shown while relay-shift is armed. */
  private relayShiftRings = new Map<string, THREE.Mesh>();
  /** Per destroyed player-relay slot: red pulsing lose-grace ring. */
  private graceRings = new Map<string, THREE.Mesh>();
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
  private relayShiftArmed = false;
  private currentState: GameState | null = null;

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
    sc.left = -140;
    sc.right = 140;
    sc.top = 140;
    sc.bottom = -140;
    sc.near = 10;
    sc.far = 320;
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
    this.controls.enableRotate = false;

    const win = canvas.ownerDocument.defaultView ?? window;
    win.addEventListener("keydown", (ev: KeyboardEvent) => {
      if (ev.altKey) this.controls.enableRotate = true;
    });
    win.addEventListener("keyup", (ev: KeyboardEvent) => {
      if (!ev.altKey) this.controls.enableRotate = false;
    });
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
    this.syncMapDecor(state);
    this.syncTerritory(state);
    this.syncMarkers(state);
    this.syncStructures(state);
    this.syncUnits(state);
    this.syncHero(state);
    this.syncHoldCubes(state);
    this.syncSelectionAndRally(state);
    this.syncCoreOrbs(state);
    this.consumeCastEvents(state);
  }

  private useGlb = false;

  setRelayShiftArmed(armed: boolean): void {
    this.relayShiftArmed = armed;
  }

  private consumeCastEvents(state: GameState): void {
    const fxEvt = state.lastFx;
    if (fxEvt && fxEvt.tick !== this.lastFxTick) {
      spawnCastFx(this.fx, fxEvt.kind, { x: fxEvt.x, z: fxEvt.z });
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
      else if (t.active && t.yieldRemaining <= 0) mat.color.set(0x888888);
      else if (t.active) mat.color.set(0x3ecf8e);
      else mat.color.set(0x8a96a6);

      // Claim channel arc (cyan), visible while hero is channeling this tap.
      let claimArc = this.tapClaimArcs.get(t.defId);
      const channeling = hero.claimChannelTarget === idx;
      if (channeling) {
        const total = Math.max(1, Math.round(HERO_CLAIM_CHANNEL_SEC * TICK_HZ));
        const frac = Math.max(0, Math.min(1, 1 - hero.claimChannelTicksRemaining / total));
        if (!claimArc) {
          claimArc = new THREE.Mesh(
            new THREE.RingGeometry(3.4, 3.9, 48, 1, 0, 0.0001),
            new THREE.MeshBasicMaterial({
              color: 0x6ae1ff,
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
      } else if (claimArc) {
        claimArc.visible = false;
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
        arc.visible = true;
      } else if (arc) {
        arc.visible = false;
      }
    }
  }

  private syncMarkers(state: GameState): void {
    this.syncTaps(state);
    this.syncCampZones(state);

    const relayPairs: {
      id: string;
      x: number;
      z: number;
      built: boolean;
      destroyed: boolean;
      team: "player" | "enemy";
      signal?: SignalType;
    }[] = [
      ...state.playerRelays.map((r) => ({
        id: `p:${r.defId}`,
        x: r.x,
        z: r.z,
        built: r.built && !r.destroyed,
        destroyed: r.destroyed,
        team: "player" as const,
        signal: r.signalTypes[0],
      })),
      ...state.enemyRelays.map((r) => ({
        id: `e:${r.defId}`,
        x: r.x,
        z: r.z,
        built: r.hp > 0,
        destroyed: r.hp <= 0,
        team: "enemy" as const,
      })),
    ];

    const elapsed = this.clock.getElapsedTime();
    const pulse = 0.5 + 0.5 * Math.sin(elapsed * 4.2);

    for (const r of relayPairs) {
      let m = this.relayMeshes.get(r.id);
      if (!m) {
        const geo = new THREE.CylinderGeometry(1.2, 1.4, 2.4, 16);
        const mat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.8 });
        m = new THREE.Mesh(geo, mat);
        m.position.y = 1.2;
        m.castShadow = true;
        m.receiveShadow = true;
        this.markers.add(m);
        this.relayMeshes.set(r.id, m);
      }
      m.position.set(r.x, 1.2, r.z);
      const mat = m.material as THREE.MeshStandardMaterial;
      if (r.team === "player") {
        if (r.built) mat.color.setHex(signalColorHex(r.signal));
        else if (r.destroyed) mat.color.set(0x553333);
        else mat.color.set(0x555d6b);
      } else {
        if (r.built) {
          const er = state.enemyRelays.find((x) => `e:${x.defId}` === r.id);
          const silenced = er && er.silencedUntilTick > state.tick;
          const base = new THREE.Color(0xff5c5c);
          if (silenced) base.multiplyScalar(0.45);
          mat.color.copy(base);
        } else {
          mat.color.set(0x444444);
        }
      }
      const s = r.built ? 1 : 0.55;
      m.scale.set(s, s, s);

      // B12: pulsing cyan ring on built player relays while shift is armed.
      if (r.team === "player" && r.built) {
        let ring = this.relayShiftRings.get(r.id);
        if (this.relayShiftArmed) {
          if (!ring) {
            ring = new THREE.Mesh(
              new THREE.RingGeometry(1.7, 2.1, 32),
              new THREE.MeshBasicMaterial({
                color: 0x6ae1ff,
                side: THREE.DoubleSide,
                transparent: true,
                opacity: 0.85,
                depthWrite: false,
              }),
            );
            ring.rotation.x = -Math.PI / 2;
            this.markers.add(ring);
            this.relayShiftRings.set(r.id, ring);
          }
          ring.position.set(r.x, 0.08, r.z);
          const s2 = 1 + pulse * 0.22;
          ring.scale.set(s2, s2, s2);
          (ring.material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.35 * pulse;
          ring.visible = true;
        } else if (ring) {
          ring.visible = false;
        }
      }

      // B1: lose-grace pulsing red ring on destroyed player slots.
      if (r.team === "player" && r.destroyed) {
        let ring = this.graceRings.get(r.id);
        const showing = state.loseGraceTicksRemaining > 0;
        if (showing) {
          if (!ring) {
            ring = new THREE.Mesh(
              new THREE.RingGeometry(2.4, 3.0, 40),
              new THREE.MeshBasicMaterial({
                color: 0xff3b3b,
                side: THREE.DoubleSide,
                transparent: true,
                opacity: 0.9,
                depthWrite: false,
              }),
            );
            ring.rotation.x = -Math.PI / 2;
            this.markers.add(ring);
            this.graceRings.set(r.id, ring);
          }
          ring.position.set(r.x, 0.09, r.z);
          const s3 = 1 + pulse * 0.3;
          ring.scale.set(s3, s3, s3);
          (ring.material as THREE.MeshBasicMaterial).opacity = 0.65 + 0.35 * pulse;
          ring.visible = true;
        } else if (ring) {
          ring.visible = false;
        }
      }
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
    // Billboard to camera.
    const cam = this.camera;
    this.heroHpBarBg.lookAt(cam.position);
    this.heroHpBarFg.lookAt(cam.position);
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
    }
  }

  render(): void {
    const dt = Math.min(0.1, this.clock.getDelta());
    this.controls.update();
    stepFx(this.fx, dt);
    // Re-run selection/rally pose updates on the flag so it keeps rotating between sim ticks.
    if (this.currentState && this.rallyFlag?.visible) {
      this.rallyFlag.rotation.y = this.clock.getElapsedTime() * 1.4;
    }
    this.renderer.render(this.scene, this.camera);
  }
}
