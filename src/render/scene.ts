import * as THREE from "three";
import { MOUSE } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { getCatalogEntry } from "../game/catalog";
import {
  HERO_CLAIM_CHANNEL_SEC,
  HERO_CLAIM_RADIUS,
  TAP_YIELD_MAX,
  TERRITORY_RADIUS,
  TICK_HZ,
} from "../game/constants";
import { dist2, unitMeshLinearSize, unitStatsForCatalog } from "../game/sim/systems/helpers";
import {
  dominantSignal,
  enemyTerritorySources,
  findKeep,
  HERO_SELECTION_ID,
  signalColorHex,
  territorySources,
  liveSquadCount,
  type GameState,
} from "../game/state";
import type { SignalType, StructureCatalogEntry, UnitSizeClass } from "../game/types";
import { isStructureEntry } from "../game/types";
import {
  clearFx,
  createFxHost,
  spawnCastFx,
  spawnCombatHitMark,
  spawnSiegeTell,
  stepFx,
  type FxHost,
} from "./fx";
import { createGroundShaderMaterial, isShaderGroundPreset } from "./groundShader";
import { requestGlbForHero, requestGlbForTower, requestGlbForUnit } from "./glbPool";

/** Exponential follow (1/s); orbit pivot eases toward the wizard without changing zoom. */
const CAMERA_HERO_FOLLOW_LAMBDA = 7.2;
/** Orbit pivot height at the wizard (Y only — XZ track hero feet). */
const CAMERA_HERO_PIVOT_Y = 1.38;
/** Match start: overhead map view eases into the default framed camera over this many seconds. */
const MATCH_INTRO_CAMERA_SEC = 3;

function makeGroundOverlayTexture(): THREE.CanvasTexture {
  const size = 512;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = "rgba(130, 190, 255, 0.16)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= size; i += 32) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(size, i);
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 2;
  for (let i = 0; i < 12; i++) {
    const y = 70 + i * 34;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(size * 0.28, y - 26, size * 0.66, y + 30, size, y - 8);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3.5, 3.5);
  return tex;
}

function structureDims(entry: StructureCatalogEntry | null): { w: number; h: number; d: number } {
  const H = unitMeshLinearSize("Titan");
  if (!entry) return { w: 4.8, h: H, d: 4.8 };
  const signals = entry.signalTypes;
  const isBastion = signals.filter((s) => s === "Bastion").length >= 2;
  const isVanguard = signals.filter((s) => s === "Vanguard").length >= 1;
  const isReclaim = signals.filter((s) => s === "Reclaim").length >= 1;
  if (entry.producedSizeClass === "Titan") return { w: 6.2, h: H, d: 6.2 };
  if (entry.producedSizeClass === "Heavy" && isBastion) return { w: 6.4, h: H, d: 6.4 };
  if (entry.producedSizeClass === "Heavy") return { w: 5.6, h: H, d: 5.6 };
  if (isBastion) return { w: 6.2, h: H, d: 6.2 };
  if (isVanguard && isReclaim) return { w: 5.1, h: H, d: 5.1 };
  if (isVanguard) return { w: 4.5, h: H, d: 4.5 };
  if (isReclaim) return { w: 5.2, h: H, d: 5.2 };
  return { w: 4.8, h: H, d: 4.8 };
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

/** Limb/torso chunkiness on top of `unitMeshLinearSize` so classes read distinct at a glance. */
function bipedBulkScale(size: UnitSizeClass): number {
  switch (size) {
    case "Swarm":
      return 0.82;
    case "Line":
      return 0.95;
    case "Heavy":
      return 1.12;
    case "Titan":
      return 1.38;
  }
}

/**
 * Strong per–size-class palette (user request), still nudged by signal + team so factions stay readable.
 */
function bipedUnitColor(size: UnitSizeClass, signal: SignalType | undefined, team: "player" | "enemy"): number {
  const basis = new THREE.Color(
    size === "Swarm"
      ? 0x3fd4c8
      : size === "Line"
        ? 0x9fe04a
        : size === "Heavy"
          ? 0xff8f2e
          : 0xad7dff,
  );
  basis.lerp(new THREE.Color(signalColorHex(signal)), 0.26);
  if (team === "player") basis.lerp(new THREE.Color(0x58b4ff), 0.2);
  else basis.lerp(new THREE.Color(0xff6048), 0.22);
  return basis.getHex();
}

/** Single merged mesh (GLB anchor): feet at y=0; total height is approximately `L`. */
function buildBipedMergedGeometry(size: UnitSizeClass, L: number): THREE.BufferGeometry {
  const b = bipedBulkScale(size);
  const legH = 0.48 * L;
  const torsoH = 0.34 * L;
  const headS = 0.18 * L;
  const spread = 0.11 * L * b;
  const legW = 0.085 * L * b;
  const legD = 0.095 * L * b;
  const torsoW = 0.2 * L * b;
  const torsoD = 0.11 * L * b;
  const armLenV = 0.37 * L;
  const armTh = 0.062 * L * b;

  const cy = legH + torsoH * 0.5;
  const shoulderY = legH + torsoH - armTh * 0.35;
  const ax = torsoW * 0.5 + armTh * 0.65;

  const parts: THREE.BufferGeometry[] = [];

  const legL = new THREE.BoxGeometry(legW, legH, legD);
  legL.translate(-spread, legH * 0.5, 0);
  parts.push(legL);

  const legR = new THREE.BoxGeometry(legW, legH, legD);
  legR.translate(spread, legH * 0.5, 0);
  parts.push(legR);

  const torso = new THREE.BoxGeometry(torsoW, torsoH, torsoD);
  torso.translate(0, cy, 0);
  parts.push(torso);

  const head = new THREE.BoxGeometry(headS, headS, headS * 0.92);
  head.translate(0, legH + torsoH + headS * 0.5, 0);
  parts.push(head);

  const armL = new THREE.BoxGeometry(armTh, armLenV, armTh);
  armL.translate(-ax, shoulderY - armLenV * 0.48, 0);
  parts.push(armL);

  const armR = new THREE.BoxGeometry(armTh, armLenV, armTh);
  armR.translate(ax, shoulderY - armLenV * 0.48, 0);
  parts.push(armR);

  return mergeGeometries(parts, false);
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

function makeEnemyCoreTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(104, 88, 8, 128, 128, 132);
  grad.addColorStop(0, "#ff9a84");
  grad.addColorStop(0.18, "#8f1f20");
  grad.addColorStop(0.58, "#260b18");
  grad.addColorStop(1, "#060812");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.globalCompositeOperation = "screen";
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    const r0 = 18 + ((i * 37) % 31);
    const r1 = 95 + ((i * 19) % 42);
    ctx.strokeStyle = i % 3 === 0 ? "rgba(255,190,150,0.48)" : "rgba(255,74,72,0.28)";
    ctx.lineWidth = i % 3 === 0 ? 2.4 : 1.2;
    ctx.beginPath();
    ctx.moveTo(128 + Math.cos(a) * r0, 128 + Math.sin(a) * r0);
    ctx.bezierCurveTo(
      128 + Math.cos(a + 0.45) * 58,
      128 + Math.sin(a + 0.45) * 58,
      128 + Math.cos(a - 0.3) * 78,
      128 + Math.sin(a - 0.3) * 78,
      128 + Math.cos(a + 0.12) * r1,
      128 + Math.sin(a + 0.12) * r1,
    );
    ctx.stroke();
  }

  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = "rgba(0,0,0,0.42)";
  ctx.fillRect(0, 160, 256, 96);
  ctx.globalCompositeOperation = "source-over";

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 2;
  return tex;
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
  (g.userData as Record<string, unknown>)["plinthMesh"] = plinth;

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
  const L = unitMeshLinearSize(size);

  const color = bipedUnitColor(size, signal, team);
  const geom = buildBipedMergedGeometry(size, L);

  const rough =
    size === "Swarm" ? 0.58 : size === "Line" ? 0.66 : size === "Heavy" ? 0.72 : 0.68;
  const body = new THREE.Mesh(geom, matFor(color, rough, 0.08));
  body.castShadow = true;
  body.receiveShadow = true;
  body.userData["isPlaceholder"] = true;
  g.add(body);
  (g.userData as Record<string, unknown>)["bodyMesh"] = body;

  return g;
}

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  private readonly ground: THREE.Mesh;
  private readonly groundOverlay: THREE.Mesh;
  private readonly hemiLight: THREE.HemisphereLight;
  private readonly sunLight: THREE.DirectionalLight;
  private groundVisualKey = "";
  private readonly root = new THREE.Group();
  private readonly markers = new THREE.Group();
  private readonly entities = new THREE.Group();
  private readonly decor = new THREE.Group();
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private unitMeshes = new Map<number, THREE.Object3D>();
  private unitCountLabels = new Map<number, LabelSprite>();
  private structureMeshes = new Map<number, THREE.Object3D>();
  private tapMeshes = new Map<string, THREE.Mesh>();
  private tapYieldArcs = new Map<string, THREE.Mesh>();
  private tapClaimArcs = new Map<string, THREE.Mesh>();
  /** Destructible claim pillar on owned Mana nodes. */
  private tapAnchorRoots = new Map<string, THREE.Group>();
  private tapAnchorPrevHp = new Map<string, number>();
  /** Floating "Stand to claim" / "Depleted" label sprites keyed by tap defId. */
  private tapLabels = new Map<string, LabelSprite>();
  /** "Next node" highlight ring on the nearest unclaimed tap to the hero. */
  private nearestTapRing: THREE.Mesh | null = null;
  private territoryGroup = new THREE.Group();
  private territoryField: THREE.Mesh | null = null;
  private enemyTerritoryField: THREE.Mesh | null = null;
  private territoryTexture: THREE.CanvasTexture | null = null;
  private enemyTerritoryTexture: THREE.CanvasTexture | null = null;
  private territoryOutline: THREE.LineSegments | null = null;
  private enemyTerritoryOutline: THREE.LineSegments | null = null;
  private territoryKey = "";
  private enemyTerritoryKey = "";
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
  /** Selected friendly troop — small halo + weapon range ring. */
  private unitSelHalo: THREE.Mesh | null = null;
  private unitMeleeRing: THREE.Mesh | null = null;
  private campAggroRings = new Map<string, THREE.Mesh>();
  private campWakeRings = new Map<string, THREE.Mesh>();
  private tacticsFieldRings = new Map<string, THREE.Mesh>();
  private decorBuilt = false;

  private ghost: THREE.Mesh | null = null;
  private cmdGhost: THREE.Mesh | null = null;
  private cmdGhostCore: THREE.Mesh | null = null;
  /** Line-strip preview for aimed cleave spells (Cut Back). */
  private cmdGhostLine: THREE.Mesh | null = null;
  private readonly controls: OrbitControls;
  private readonly clock = new THREE.Clock();
  /** Animation/render delta must not use `clock.getDelta()` because sync code calls `getElapsedTime()` for pulses. */
  private lastRenderFrameMs = performance.now();
  private readonly composer: EffectComposer;
  private readonly bloomPass: UnrealBloomPass;
  private bloomEnabled = false;
  private rollingFps = 60;
  private bloomDecisionMs = 0;
  /** Scratch: camera-relative WASD on the XZ plane (world up). */
  private readonly camGroundFwd = new THREE.Vector3();
  private readonly camGroundRight = new THREE.Vector3();
  private readonly fx: FxHost;
  private lastSiegeTick = -1;
  private currentState: GameState | null = null;
  private worldPlaneHalf = 0;
  /** Imported terrain (GLB); raycast targets for `pickGround` when present. */
  private terrainRoot: THREE.Group | null = null;
  private terrainHits: THREE.Object3D[] = [];
  private terrainSource: string | null = null;
  private readonly unitPrevHp = new Map<number, number>();
  private readonly unitPrevAttackTick = new Map<number, number>();
  private readonly unitPrevPos = new Map<number, THREE.Vector2>();
  private readonly dyingUnits: { obj: THREE.Object3D; timer: number; life: number; particles: THREE.Mesh[] }[] = [];
  private readonly structurePrevHp = new Map<number, number>();
  private readonly relayPrevHp = new Map<string, number>();
  /** Seconds of forward lunge after a wizard strike FX. */
  private heroLungeTimer = 0;
  /** Skeleton animation update accumulator; large armies update animation at a capped cadence. */
  private glbAnimationAccumSec = 0;
  /** When true, orbit pivot eases toward the player wizard each frame; when false, MMB orbit stays put. */
  private cameraFollowHero = true;
  private cameraFollowUnitId: number | null = null;
  private cameraFramedState: GameState | null = null;
  private lastCameraLimitsHalf = 0;

  /** `performance.now()` when intro began; null = idle. */
  private introCinematicStartMs: number | null = null;
  private readonly introStartPos = new THREE.Vector3();
  private readonly introStartTgt = new THREE.Vector3();
  private readonly introEndPos = new THREE.Vector3();
  private readonly introEndTgt = new THREE.Vector3();
  private readonly introScratchCam = new THREE.Vector3();
  /** Orbit / pan allowed (e.g. false while dragging a doctrine card). */
  private controlsUserDesiredEnabled = true;

  /** Rigid translate: preserves camera↔target offset (OrbitControls distance = zoom). */
  private nudgeCameraRigTowardFollowPivot(dt: number): void {
    if (this.introCinematicStartMs !== null) return;
    const state = this.currentState;
    if (!state || state.phase !== "playing") return;
    const unit =
      this.cameraFollowUnitId !== null ? state.units.find((u) => u.id === this.cameraFollowUnitId && u.hp > 0) : null;
    if (this.cameraFollowUnitId !== null && !unit) this.cameraFollowUnitId = null;
    const followed = unit ?? (this.cameraFollowHero ? state.hero : null);
    if (!followed) return;
    const t = this.controls.target;
    const desiredX = followed.x;
    const desiredY = unit ? Math.max(1.0, unitMeshLinearSize(unit.sizeClass) * 0.8) : CAMERA_HERO_PIVOT_Y;
    const desiredZ = followed.z;
    const alpha = 1 - Math.exp(-CAMERA_HERO_FOLLOW_LAMBDA * dt);
    const dx = (desiredX - t.x) * alpha;
    const dy = (desiredY - t.y) * alpha;
    const dz = (desiredZ - t.z) * alpha;
    if (dx * dx + dy * dy + dz * dz < 1e-14) return;
    t.x += dx;
    t.y += dy;
    t.z += dz;
    this.camera.position.x += dx;
    this.camera.position.y += dy;
    this.camera.position.z += dz;
  }

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: "high-performance",
      stencil: false,
      depth: true,
    });
    /** Cap DPR for 120Hz — full retina is often fill-rate bound. */
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
    this.renderer.shadowMap.enabled = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.04;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0e1116);

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.5, 2600);
    this.camera.position.set(82, 96, 82);
    this.camera.lookAt(0, 4, 0);

    this.scene.add(new THREE.AmbientLight(0xcfd9ff, 0.38));
    this.hemiLight = new THREE.HemisphereLight(0x9eb7ff, 0x1a1e28, 0.35);
    this.scene.add(this.hemiLight);
    this.sunLight = new THREE.DirectionalLight(0xfff4e6, 1.05);
    this.sunLight.position.set(-55, 110, 40);
    this.sunLight.castShadow = false;
    this.scene.add(this.sunLight);

    const groundMat = new THREE.MeshStandardMaterial({ color: 0x1b2430, roughness: 0.92, metalness: 0.04 });
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = false;
    this.scene.add(this.ground);
    this.groundOverlay = new THREE.Mesh(
      new THREE.PlaneGeometry(240, 240),
      new THREE.MeshBasicMaterial({
        map: makeGroundOverlayTexture(),
        transparent: true,
        opacity: 0.24,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.groundOverlay.rotation.x = -Math.PI / 2;
    this.groundOverlay.position.y = 0.018;
    this.scene.add(this.groundOverlay);

    this.territoryGroup.name = "territory";
    this.root.add(this.decor, this.markers, this.entities, this.territoryGroup);
    this.scene.add(this.root);

    this.fx = createFxHost(this.scene);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = false;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 34;
    this.controls.maxDistance = 280;
    /** Keep the lens low — more horizon, less RTS “map cam”. */
    this.controls.maxPolarAngle = Math.PI / 2 - 0.06;
    this.controls.minPolarAngle = 0.82;
    this.controls.zoomSpeed = 0.82;
    this.controls.rotateSpeed = 0.36;
    this.controls.panSpeed = 0.92;
    this.controls.enableRotate = true;
    this.controls.enablePan = true;
    // LMB/RMB stay with the game; middle = pan the rig. Shift+MMB = orbit (OrbitControls default for PAN+modifier).
    (this.controls as unknown as { mouseButtons: { LEFT: number; MIDDLE: number; RIGHT: number } }).mouseButtons = {
      LEFT: -1,
      MIDDLE: MOUSE.PAN,
      RIGHT: -1,
    };

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.16, 0.32, 0.88);
    this.composer.addPass(this.bloomPass);
  }

  /** Drop all cast FX (lightning, rings, etc.) — call on rematch so bolts never linger. */
  clearCastFx(): void {
    clearFx(this.fx);
  }

  setSize(w: number, h: number): void {
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    const aspect = w / Math.max(1, h);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  setControlsEnabled(enabled: boolean): void {
    this.controlsUserDesiredEnabled = enabled;
    this.refreshControlsEnabledFromIntro();
  }

  private refreshControlsEnabledFromIntro(): void {
    this.controls.enabled = this.controlsUserDesiredEnabled && this.introCinematicStartMs === null;
  }

  rotateCameraByPixels(dx: number, dy: number): void {
    this.cameraFollowHero = false;
    this.cameraFollowUnitId = null;
    const target = this.controls.target;
    const off = this.camera.position.clone().sub(target);
    const sph = new THREE.Spherical().setFromVector3(off);
    sph.theta -= dx * 0.006;
    sph.phi = Math.max(this.controls.minPolarAngle, Math.min(this.controls.maxPolarAngle, sph.phi - dy * 0.004));
    off.setFromSpherical(sph);
    this.camera.position.copy(target).add(off);
    this.camera.lookAt(target);
    this.controls.update();
  }

  /**
   * Normalized XZ basis for camera-relative WASD: **W/S** = along the camera view direction flattened
   * onto the ground; **A/D** = strafe (right-hand rule with world +Y). Matches typical third-person controls.
   */
  getCameraGroundMoveBasis(): { fx: number; fz: number; rx: number; rz: number } {
    this.camera.updateMatrixWorld(true);
    this.camera.getWorldDirection(this.camGroundFwd);
    this.camGroundFwd.y = 0;
    let len = this.camGroundFwd.length();
    if (len < 1e-5) {
      const st = this.currentState;
      if (st?.phase === "playing") {
        const face = st.hero.facing;
        this.camGroundFwd.set(Math.sin(face), 0, Math.cos(face));
      } else {
        this.camGroundFwd.set(0, 0, 1);
      }
      len = 1;
    } else {
      this.camGroundFwd.multiplyScalar(1 / len);
    }
    const fx = this.camGroundFwd.x;
    const fz = this.camGroundFwd.z;
    this.camGroundRight.crossVectors(this.camGroundFwd, this.camera.up).normalize();
    this.camGroundRight.y = 0;
    if (this.camGroundRight.lengthSq() < 1e-8) {
      this.camGroundRight.set(fz, 0, -fx);
    } else {
      this.camGroundRight.normalize();
    }
    return { fx, fz, rx: this.camGroundRight.x, rz: this.camGroundRight.z };
  }

  panCameraOnGround(strafe: number, forward: number, dt: number): void {
    const sx = Math.max(-1, Math.min(1, strafe));
    const fwd = Math.max(-1, Math.min(1, forward));
    if (sx === 0 && fwd === 0) return;
    const { fx, fz, rx, rz } = this.getCameraGroundMoveBasis();
    let dx = fwd * fx + sx * rx;
    let dz = fwd * fz + sx * rz;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return;
    dx /= len;
    dz /= len;
    const distance = this.camera.position.distanceTo(this.controls.target);
    const speed = Math.max(24, Math.min(180, distance * 1.18));
    const rawX = dx * speed * Math.max(0, dt);
    const rawZ = dz * speed * Math.max(0, dt);
    const half = this.currentState?.map.world.halfExtents ?? this.worldPlaneHalf;
    const target = this.controls.target;
    const nextX = Math.max(-half, Math.min(half, target.x + rawX));
    const nextZ = Math.max(-half, Math.min(half, target.z + rawZ));
    const moveX = nextX - target.x;
    const moveZ = nextZ - target.z;
    if (Math.abs(moveX) + Math.abs(moveZ) < 1e-6) return;
    this.cameraFollowHero = false;
    this.cameraFollowUnitId = null;
    target.x += moveX;
    target.z += moveZ;
    this.camera.position.x += moveX;
    this.camera.position.z += moveZ;
    this.controls.update();
  }

  getCameraFollowHero(): boolean {
    return this.cameraFollowHero;
  }

  /** Snap orbit pivot to the player wizard (used when re-enabling follow mode). */
  setCameraFollowHero(follow: boolean): void {
    this.cameraFollowHero = follow;
    if (follow) this.cameraFollowUnitId = null;
    if (follow) this.snapCameraPivotToPlayerHero();
  }

  /** @returns new follow state */
  toggleCameraFollowHero(): boolean {
    this.cameraFollowHero = !this.cameraFollowHero;
    if (this.cameraFollowHero) {
      this.cameraFollowUnitId = null;
      this.snapCameraPivotToPlayerHero();
    }
    return this.cameraFollowHero;
  }

  zoomCameraToSelectedUnit(): boolean {
    const st = this.currentState;
    if (!st || st.phase !== "playing") return false;
    const selectedUnitId = st.selectedUnitIds.find((id) => id !== HERO_SELECTION_ID) ?? st.selectedUnitId;
    const u = selectedUnitId != null ? st.units.find((x) => x.id === selectedUnitId && x.team === "player" && x.hp > 0) : null;
    if (!u) {
      if (!st.selectedUnitIds.includes(HERO_SELECTION_ID) || st.hero.hp <= 0) return false;
      this.cameraFollowHero = true;
      this.cameraFollowUnitId = null;
      this.controls.minDistance = Math.min(this.controls.minDistance, 8);
      this.controls.target.set(st.hero.x, CAMERA_HERO_PIVOT_Y, st.hero.z);
      this.camera.position.set(st.hero.x - 10, CAMERA_HERO_PIVOT_Y + 7, st.hero.z - 10);
      this.controls.update();
      return true;
    }
    const enemy = st.map.enemyStart ?? st.enemyHero;
    let dx = enemy.x - u.x;
    let dz = enemy.z - u.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    const size = unitMeshLinearSize(u.sizeClass);
    const targetY = Math.max(1.0, size * 0.8);
    const back = Math.max(9, size * 4.2);
    const height = Math.max(5.5, size * 2.4);
    this.cameraFollowHero = false;
    this.cameraFollowUnitId = u.id;
    this.controls.minDistance = Math.min(this.controls.minDistance, 8);
    this.controls.target.set(u.x + dx * size * 0.8, targetY, u.z + dz * size * 0.8);
    this.camera.position.set(u.x - dx * back, targetY + height, u.z - dz * back);
    this.controls.update();
    return true;
  }

  /** Snap pivot to hero in one frame without changing camera–target distance (zoom unchanged). */
  private snapCameraPivotToPlayerHero(): void {
    const st = this.currentState;
    if (!st || st.phase !== "playing") return;
    const h = st.hero;
    const t = this.controls.target;
    const nx = h.x;
    const ny = CAMERA_HERO_PIVOT_Y;
    const nz = h.z;
    const dx = nx - t.x;
    const dy = ny - t.y;
    const dz = nz - t.z;
    t.set(nx, ny, nz);
    this.camera.position.x += dx;
    this.camera.position.y += dy;
    this.camera.position.z += dz;
    this.controls.update();
  }

  private syncCameraLimits(half: number): void {
    if (half === this.lastCameraLimitsHalf) return;
    this.lastCameraLimitsHalf = half;
    this.controls.minDistance = Math.max(28, half * 0.055);
    this.controls.maxDistance = Math.min(1500, Math.max(260, half * 2.35));
    this.camera.far = Math.max(2200, half * 6.2);
    this.camera.updateProjectionMatrix();
  }

  /** Default match opening rig (orbit target + camera) — same framing as pre-intro gameplay. */
  private getDefaultFramedCameraRig(state: GameState): { pos: THREE.Vector3; tgt: THREE.Vector3 } {
    const home = findKeep(state) ?? state.map.playerStart ?? state.hero;
    const enemy = state.map.enemyStart ?? state.enemyHero;
    let dx = enemy.x - home.x;
    let dz = enemy.z - home.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    const half = state.map.world.halfExtents;
    const lead = Math.max(46, Math.min(120, half * 0.24));
    const back = Math.max(32, Math.min(88, half * 0.16));
    const height = Math.max(40, Math.min(84, half * 0.15));
    const targetY = CAMERA_HERO_PIVOT_Y;
    const tgt = new THREE.Vector3(home.x + dx * lead, targetY, home.z + dz * lead);
    const pos = new THREE.Vector3(home.x - dx * back, targetY + height, home.z - dz * back);
    return { pos, tgt };
  }

  /** Top-down start, then ease into `getDefaultFramedCameraRig` with a horizontal half-turn mid-flight. */
  private startMatchIntroCinematic(state: GameState): void {
    const { pos: endPos, tgt: endTgt } = this.getDefaultFramedCameraRig(state);
    this.introEndPos.copy(endPos);
    this.introEndTgt.copy(endTgt);
    const half = state.map.world.halfExtents;
    const H = Math.max(half * 2.55, 230);
    this.introStartTgt.set(0, 0, 0);
    this.introStartPos.set(0, H, 0);
    this.controls.target.copy(this.introStartTgt);
    this.camera.position.copy(this.introStartPos);
    this.camera.lookAt(this.introStartTgt);
    this.controls.update();
    this.introCinematicStartMs = performance.now();
    this.refreshControlsEnabledFromIntro();
    this.cameraFollowHero = false;
    this.cameraFollowUnitId = null;
    this.cameraFramedState = state;
  }

  private tickMatchIntroCinematic(): void {
    if (this.introCinematicStartMs === null) return;
    const elapsed = (performance.now() - this.introCinematicStartMs) / 1000;
    const u = Math.max(0, Math.min(1, elapsed / MATCH_INTRO_CAMERA_SEC));
    const s = u * u * (3 - 2 * u);
    this.controls.target.copy(this.introStartTgt).lerp(this.introEndTgt, s);
    this.introScratchCam.copy(this.introStartPos).lerp(this.introEndPos, s);
    const ox = this.introScratchCam.x - this.controls.target.x;
    const oy = this.introScratchCam.y - this.controls.target.y;
    const oz = this.introScratchCam.z - this.controls.target.z;
    const hr = Math.hypot(ox, oz);
    const a = Math.atan2(oz, ox) + Math.sin(s * Math.PI) * Math.PI;
    this.camera.position.set(
      this.controls.target.x + Math.cos(a) * hr,
      this.controls.target.y + oy,
      this.controls.target.z + Math.sin(a) * hr,
    );
    this.camera.lookAt(this.controls.target);
    this.controls.update();
    if (u >= 1) {
      this.controls.target.copy(this.introEndTgt);
      this.camera.position.copy(this.introEndPos);
      this.controls.update();
      this.introCinematicStartMs = null;
      this.refreshControlsEnabledFromIntro();
    }
  }

  pickGround(clientX: number, clientY: number, rect: DOMRect): { x: number; z: number } | null {
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -(((clientY - rect.top) / rect.height) * 2 - 1);
    this.ndc.set(x, y);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    if (this.terrainHits.length > 0) {
      const hits = this.raycaster.intersectObjects(this.terrainHits, false);
      const p = hits[0]?.point;
      if (p) return { x: p.x, z: p.z };
    }
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.plane, hit)) return null;
    return { x: hit.x, z: hit.z };
  }

  /** First unit mesh hit by screen ray (for selection); null if none. */
  pickUnitId(clientX: number, clientY: number, rect: DOMRect): number | null {
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -(((clientY - rect.top) / rect.height) * 2 - 1);
    this.ndc.set(x, y);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    if (this.unitMeshes.size === 0) return null;
    const hits = this.raycaster.intersectObjects([...this.unitMeshes.values()], true);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o) {
        const uid = o.userData["unitId"] as number | undefined;
        if (uid !== undefined) return uid;
        o = o.parent;
      }
    }
    return null;
  }

  pickUnitIdsInScreenRect(a: { x: number; y: number }, b: { x: number; y: number }, rect: DOMRect): number[] {
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    const ids: number[] = [];
    const st = this.currentState;
    if (!st) return ids;
    if (st.hero.hp > 0) {
      const hp = new THREE.Vector3(st.hero.x, 1.6, st.hero.z).project(this.camera);
      const hsx = rect.left + ((hp.x + 1) / 2) * rect.width;
      const hsy = rect.top + ((1 - hp.y) / 2) * rect.height;
      if (hsx >= minX && hsx <= maxX && hsy >= minY && hsy <= maxY) ids.push(HERO_SELECTION_ID);
    }
    for (const u of st.units) {
      if (u.team !== "player" || u.hp <= 0) continue;
      const p = new THREE.Vector3(u.x, 1.2, u.z).project(this.camera);
      const sx = rect.left + ((p.x + 1) / 2) * rect.width;
      const sy = rect.top + ((1 - p.y) / 2) * rect.height;
      if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) ids.push(u.id);
    }
    return ids;
  }

  /** Remove custom terrain and show the default ground plane again. */
  clearTerrain(): void {
    if (this.terrainRoot) {
      this.terrainRoot.traverse((obj) => {
        const m = obj as THREE.Mesh;
        if (!m.isMesh) return;
        m.geometry?.dispose();
        const mat = m.material;
        if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose());
        else (mat as THREE.Material | undefined)?.dispose?.();
      });
      this.scene.remove(this.terrainRoot);
      this.terrainRoot = null;
    }
    this.terrainHits = [];
    this.terrainSource = null;
    this.ground.visible = true;
  }

  /** Load GLB/GLTF terrain from `map.terrainGlbUrl` (site-root path). */
  async loadTerrainFromMap(map: { terrainGlbUrl?: string }): Promise<void> {
    const url = map.terrainGlbUrl?.trim();
    if (!url) {
      this.clearTerrain();
      return;
    }
    if (url === this.terrainSource && this.terrainRoot) return;

    this.clearTerrain();
    this.terrainSource = url;
    const loader = new GLTFLoader();
    try {
      const gltf = await loader.loadAsync(url);
      const root = new THREE.Group();
      root.name = "terrain_import";
      root.add(gltf.scene);
      root.updateMatrixWorld(true);
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.castShadow = true;
          m.receiveShadow = true;
          this.terrainHits.push(m);
        }
      });
      this.terrainRoot = root;
      this.scene.add(root);
      this.ground.visible = false;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("Failed to load terrain GLB:", url, e);
      this.clearTerrain();
    }
  }

  sync(state: GameState, useGlb: boolean): void {
    this.currentState = state;
    this.useGlb = useGlb;
    this.syncWorldPlane(state);
    this.syncCameraLimits(state.map.world.halfExtents);
    if (this.cameraFramedState !== state) this.startMatchIntroCinematic(state);
    this.applyMapVisual(state);
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
    const q = state.fxQueue;
    if (q.length > 0) {
      for (const fxEvt of q) {
        const boltFrom =
          fxEvt.fromX !== undefined && fxEvt.fromZ !== undefined
            ? { from: { x: fxEvt.fromX, z: fxEvt.fromZ } }
            : undefined;
        spawnCastFx(this.fx, fxEvt.kind, { x: fxEvt.x, z: fxEvt.z }, {
          ...boltFrom,
          strikeVariant: fxEvt.strikeVariant,
          impactRadius: fxEvt.impactRadius,
          rangeBand: fxEvt.rangeBand,
        });
        if (fxEvt.kind === "hero_strike") this.heroLungeTimer = 0.2;
      }
      q.length = 0;
    }
    const siege = state.lastSiegeHit;
    if (siege && siege.tick !== this.lastSiegeTick) {
      spawnSiegeTell(this.fx, { x: siege.x, z: siege.z });
      this.lastSiegeTick = siege.tick;
    }
    const marks = state.combatHitMarks;
    if (marks.length > 0) {
      for (const m of marks) {
        spawnCombatHitMark(this.fx, m);
      }
      marks.length = 0;
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
        depthWrite: false,
        blending: THREE.AdditiveBlending,
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
   * When `line` is set, `pos` is the aim point and a corridor from `line.from*` toward `pos` is shown.
   */
  setCommandGhost(
    pos: { x: number; z: number } | null,
    radius: number | null,
    valid: boolean,
    line?: { fromX: number; fromZ: number; length: number; halfWidth: number } | null,
  ): void {
    if (!pos) {
      if (this.cmdGhost) this.cmdGhost.visible = false;
      if (this.cmdGhostCore) this.cmdGhostCore.visible = false;
      if (this.cmdGhostLine) this.cmdGhostLine.visible = false;
      return;
    }

    if (line) {
      if (this.cmdGhost) this.cmdGhost.visible = false;
      if (this.cmdGhostCore) this.cmdGhostCore.visible = false;

      let dx = pos.x - line.fromX;
      let dz = pos.z - line.fromZ;
      const d0 = Math.hypot(dx, dz);
      if (d0 < 1e-3) {
        dx = 1;
        dz = 0;
      } else {
        dx /= d0;
        dz /= d0;
      }
      const L = line.length;
      const ex = line.fromX + dx * L;
      const ez = line.fromZ + dz * L;
      const cx = (line.fromX + ex) * 0.5;
      const cz = (line.fromZ + ez) * 0.5;
      const hw = line.halfWidth;

      if (!this.cmdGhostLine) {
        const mat = new THREE.MeshBasicMaterial({
          color: 0xc8ffe8,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.42,
          depthWrite: false,
          depthTest: false,
          blending: THREE.AdditiveBlending,
        });
        this.cmdGhostLine = new THREE.Mesh(new THREE.BoxGeometry(1, 0.14, 1), mat);
        this.cmdGhostLine.position.y = 0.1;
        this.scene.add(this.cmdGhostLine);
      }
      const mesh = this.cmdGhostLine;
      mesh.visible = true;
      mesh.position.set(cx, 0.1, cz);
      mesh.rotation.y = Math.atan2(ex - line.fromX, ez - line.fromZ);
      (mesh.material as THREE.MeshBasicMaterial).color.set(valid ? 0xc8ffe8 : 0xffb0b8);
      (mesh.material as THREE.MeshBasicMaterial).opacity = valid ? 0.42 : 0.36;
      mesh.geometry.dispose();
      mesh.geometry = new THREE.BoxGeometry(hw * 2, 0.14, L);
      return;
    }

    if (this.cmdGhostLine) this.cmdGhostLine.visible = false;

    if (!this.cmdGhost) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xd87bff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
        depthTest: false,
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
        depthTest: false,
        blending: THREE.AdditiveBlending,
      });
      this.cmdGhostCore = new THREE.Mesh(new THREE.RingGeometry(0.35, 0.65, 32), coreMat);
      this.cmdGhostCore.rotation.x = -Math.PI / 2;
      this.cmdGhostCore.position.y = 0.09;
      this.scene.add(this.cmdGhostCore);
    }

    const r = Math.max(1, radius ?? 1.5);
    this.cmdGhost.geometry.dispose();
    this.cmdGhost.geometry = new THREE.RingGeometry(Math.max(0.1, r - 0.35), r, 64);
    this.cmdGhost.position.set(pos.x, 0.08, pos.z);
    this.cmdGhost.visible = true;
    (this.cmdGhost.material as THREE.MeshBasicMaterial).color.set(valid ? 0xd87bff : 0xff6a6a);

    const inner = Math.max(0.2, Math.min(1.2, (radius ?? 1.5) * 0.14));
    this.cmdGhostCore.geometry.dispose();
    this.cmdGhostCore.geometry = new THREE.RingGeometry(inner * 0.55, inner, 40);
    this.cmdGhostCore.position.set(pos.x, 0.09, pos.z);
    this.cmdGhostCore.visible = true;
    (this.cmdGhostCore.material as THREE.MeshBasicMaterial).color.set(
      valid ? 0xf0c8ff : 0xffb3b3,
    );
  }

  private syncTaps(state: GameState): void {
    const hero = state.hero;
    const claimR = HERO_CLAIM_RADIUS;
    const ringIn = claimR * 0.58;
    const ringOut = claimR * 0.92;
    const chIn = claimR * 0.76;
    const chOut = claimR * 0.98;
    const yIn = claimR * 0.22;
    const yOut = claimR * 0.36;
    const nhIn = claimR * 0.88;
    const nhOut = claimR * 1.08;

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
        const geo = new THREE.RingGeometry(ringIn, ringOut, 32);
        const mat = new THREE.MeshBasicMaterial({
          color: 0x666666,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
          depthTest: false,
          blending: THREE.AdditiveBlending,
        });
        m = new THREE.Mesh(geo, mat);
        m.rotation.x = -Math.PI / 2;
        m.position.y = 0.05;
        this.markers.add(m);
        this.tapMeshes.set(t.defId, m);
      }
      m.position.set(t.x, 0.05, t.z);
      const mat = m.material as THREE.MeshBasicMaterial;
      const nodeR2 = HERO_CLAIM_RADIUS * HERO_CLAIM_RADIUS;
      const playerNear = state.units.some((u) => u.team === "player" && u.hp > 0 && dist2(u, t) <= nodeR2);
      const enemyNear = state.units.some((u) => u.team === "enemy" && u.hp > 0 && dist2(u, t) <= nodeR2);
      const contested = playerNear && enemyNear;
      if (contested) mat.color.set(0xffd36a);
      else if (t.active && t.ownerTeam === "player") mat.color.set(0x54c7ff);
      else if (t.active && t.ownerTeam === "enemy") mat.color.set(0xff6b6b);
      else if (t.active && t.yieldRemaining <= 0) mat.color.set(0x7d8895);
      else if (t.active) mat.color.set(0x52b0ff);
      else mat.color.set(0xc1ccd8);
      mat.opacity = contested ? 1 : t.active ? 0.92 : 0.72;

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
            new THREE.RingGeometry(chIn, chOut, 48, 1, 0, 0.0001),
            new THREE.MeshBasicMaterial({
              color: state.enemyHero.claimChannelTarget === idx ? 0xff8a8a : 0x6ae1ff,
              side: THREE.DoubleSide,
              transparent: true,
              opacity: 0.95,
              depthWrite: false,
              depthTest: false,
              blending: THREE.AdditiveBlending,
            }),
          );
          claimArc.rotation.x = -Math.PI / 2;
          claimArc.position.y = 0.07;
          this.markers.add(claimArc);
          this.tapClaimArcs.set(t.defId, claimArc);
        }
        claimArc.position.set(t.x, 0.07, t.z);
        const channelKey = isEnemyChannel
          ? `e:${state.enemyHero.claimChannelTicksRemaining}`
          : `p:${hero.claimChannelTicksRemaining}`;
        const ud = claimArc.userData as Record<string, unknown>;
        if (ud["channelGeomKey"] !== channelKey) {
          ud["channelGeomKey"] = channelKey;
          claimArc.geometry.dispose();
          claimArc.geometry = new THREE.RingGeometry(
            chIn,
            chOut,
            48,
            1,
            -Math.PI / 2,
            Math.max(0.0001, frac * Math.PI * 2),
          );
        }
        claimArc.visible = true;
        (claimArc.material as THREE.MeshBasicMaterial).color.set(isEnemyChannel ? 0xff8a8a : 0x6ae1ff);
      } else if (claimArc) {
        claimArc.visible = false;
        (claimArc.userData as Record<string, unknown>)["channelGeomKey"] = undefined;
      }

      // Floating label: "Stand to claim — 20 Mana" on unclaimed taps, "Depleted"
      // on dried-up ones. Hidden once the player owns the tap.
      let label = this.tapLabels.get(t.defId);
      const claimedByPlayer = t.active && t.ownerTeam === "player";
      const claimedByEnemy = t.active && t.ownerTeam === "enemy";
      const depleted = t.active && t.yieldRemaining <= 0;
      const anchorUp = (t.anchorHp ?? 0) > 0;
      if (!claimedByPlayer && !claimedByEnemy) {
        if (!label) {
          label = makeLabelSprite("Stand to claim", "#6ae1ff");
          this.markers.add(label.sprite);
          this.tapLabels.set(t.defId, label);
        }
        const text = depleted ? "Node depleted" : contested ? "Contested Mana" : "Claim Mana node";
        const accent = depleted ? "#8a96a6" : contested ? "#ffd36a" : "#6ae1ff";
        drawLabel(label, text, accent);
        label.sprite.position.set(t.x, Math.max(5.2, claimR * 0.45 + 3.8), t.z);
        label.sprite.visible = true;
        (label.sprite.material as THREE.SpriteMaterial).opacity = depleted ? 0.55 : 1;
      } else if (claimedByEnemy && anchorUp) {
        if (!label) {
          label = makeLabelSprite("Destroy anchor", "#ff9a7a");
          this.markers.add(label.sprite);
          this.tapLabels.set(t.defId, label);
        }
        drawLabel(label, "Destroy red anchor", "#ff9a7a");
        label.sprite.position.set(t.x, Math.max(6, claimR * 0.48 + 4.2), t.z);
        label.sprite.visible = true;
        (label.sprite.material as THREE.SpriteMaterial).opacity = 0.95;
      } else if (label) {
        label.sprite.visible = false;
      }

      let arc = this.tapYieldArcs.get(t.defId);
      const active = t.active && t.yieldRemaining > 0 && (t.anchorHp ?? 0) > 0;
      if (active) {
        const frac = Math.max(0, Math.min(1, t.yieldRemaining / TAP_YIELD_MAX));
        if (!arc) {
          arc = new THREE.Mesh(
            new THREE.RingGeometry(yIn, yOut, 48, 1, 0, Math.PI * 2),
            new THREE.MeshBasicMaterial({
              color: 0x6ab8ff,
              side: THREE.DoubleSide,
              transparent: true,
              opacity: 0.9,
              depthWrite: false,
              depthTest: false,
              blending: THREE.AdditiveBlending,
            }),
          );
          arc.rotation.x = -Math.PI / 2;
          arc.position.y = 0.07;
          this.markers.add(arc);
          this.tapYieldArcs.set(t.defId, arc);
        }
        arc.position.set(t.x, 0.07, t.z);
        const yieldKey = `${t.ownerTeam}:${t.yieldRemaining}`;
        const arcUd = arc.userData as Record<string, unknown>;
        if (arcUd["yieldGeomKey"] !== yieldKey) {
          arcUd["yieldGeomKey"] = yieldKey;
          arc.geometry.dispose();
          arc.geometry = new THREE.RingGeometry(
            yIn,
            yOut,
            48,
            1,
            Math.PI / 2 - frac * Math.PI,
            Math.max(0.0001, frac * Math.PI * 2),
          );
        }
        (arc.material as THREE.MeshBasicMaterial).color.set(
          t.ownerTeam === "enemy" ? 0xff7070 : 0x6ab8ff,
        );
        arc.visible = true;
      } else if (arc) {
        arc.visible = false;
        (arc.userData as Record<string, unknown>)["yieldGeomKey"] = undefined;
      }
    }

    const aliveAnchors = new Set<string>();
    for (const t of state.taps) {
      if (!t.active || !t.ownerTeam) continue;
      if ((t.anchorHp ?? 0) <= 0) continue;
      aliveAnchors.add(t.defId);
      let g = this.tapAnchorRoots.get(t.defId);
      if (!g) {
        g = new THREE.Group();
        const body = new THREE.Mesh(
          new THREE.CylinderGeometry(0.42, 0.52, 1.12, 12),
          new THREE.MeshStandardMaterial({
            color: 0x9eb6d4,
            roughness: 0.52,
            metalness: 0.12,
            emissive: 0x0a1420,
          }),
        );
        body.position.y = 0.56;
        body.castShadow = true;
        body.receiveShadow = true;
        body.userData["bodyMesh"] = body;
        g.userData["bodyMesh"] = body;
        g.add(body);
        this.markers.add(g);
        this.tapAnchorRoots.set(t.defId, g);
      }
      g.position.set(t.x, 0, t.z);
      const body = g.userData["bodyMesh"] as THREE.Mesh;
      const mat = body.material as THREE.MeshStandardMaterial;
      mat.color.setHex(t.ownerTeam === "player" ? 0x5ba8e8 : 0xd86060);
      const fg = t.ownerTeam === "player" ? 0x7ec8ff : 0xff8888;
      const pair = this.ensureHpBarPair(g, "tapA", 1.32, fg);
      const maxA = Math.max(1, t.anchorMaxHp ?? 1);
      const hpA = t.anchorHp ?? 0;
      this.setHpBarFrac(pair, hpA / maxA);
      const prev = this.tapAnchorPrevHp.get(t.defId);
      if (prev !== undefined && hpA < prev - 0.5) {
        (g.userData as Record<string, unknown>)["hitPulse"] = 0.22;
      }
      this.tapAnchorPrevHp.set(t.defId, hpA);
    }
    for (const [defId, g] of this.tapAnchorRoots) {
      if (!aliveAnchors.has(defId)) {
        this.markers.remove(g);
        this.disposeObject(g);
        this.tapAnchorRoots.delete(defId);
        this.tapAnchorPrevHp.delete(defId);
      }
    }

    // Pulsing "next target" ring sitting just outside the tap ring.
    if (nearestId !== null) {
      const t = state.taps.find((x) => x.defId === nearestId)!;
      if (!this.nearestTapRing) {
        this.nearestTapRing = new THREE.Mesh(
          new THREE.RingGeometry(nhIn, nhOut, 48),
          new THREE.MeshBasicMaterial({
            color: 0x6ae1ff,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.85,
            depthWrite: false,
            depthTest: false,
            blending: THREE.AdditiveBlending,
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
    this.syncTacticsFields(state);

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

  private syncTacticsFields(state: GameState): void {
    const alive = new Set<string>();
    for (let i = 0; i < state.tacticsFieldZones.length; i++) {
      const zf = state.tacticsFieldZones[i]!;
      const key = `${i}:${Math.round(zf.x * 10)}:${Math.round(zf.z * 10)}:${zf.untilTick}`;
      alive.add(key);
      let ring = this.tacticsFieldRings.get(key);
      if (!ring) {
        ring = new THREE.Mesh(
          new THREE.RingGeometry(0.92, 1, 96),
          new THREE.MeshBasicMaterial({
            color: 0x7fe7ff,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.36,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.072;
        this.markers.add(ring);
        this.tacticsFieldRings.set(key, ring);
      }
      const lifeFrac = Math.max(0, Math.min(1, (zf.untilTick - state.tick) / Math.max(1, 14 * TICK_HZ)));
      ring.position.set(zf.x, 0.072, zf.z);
      ring.scale.setScalar(Math.max(1, zf.radius));
      const mat = ring.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.16 + lifeFrac * 0.24;
      mat.color.set(lifeFrac < 0.25 ? 0xffd86a : 0x7fe7ff);
    }
    for (const [key, ring] of this.tacticsFieldRings) {
      if (alive.has(key)) continue;
      this.markers.remove(ring);
      this.disposeObject(ring);
      this.tacticsFieldRings.delete(key);
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
            depthTest: false,
            blending: THREE.AdditiveBlending,
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
            depthTest: false,
            blending: THREE.AdditiveBlending,
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
      } else if (c instanceof THREE.Sprite) {
        const mat = c.material;
        if (Array.isArray(mat)) {
          mat.forEach((m) => {
            m.map?.dispose();
            m.dispose();
          });
        } else {
          mat.map?.dispose();
          mat.dispose();
        }
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
          depthTest: false,
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
          depthTest: false,
          blending: THREE.AdditiveBlending,
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
    const fracKey = Math.round(frac * 200);
    const arcUd = this.keepHpArc.userData as Record<string, unknown>;
    if (arcUd["keepArcFracKey"] !== fracKey) {
      arcUd["keepArcFracKey"] = fracKey;
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
    }
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

      const dims = structureDims(structEntry);
      const fg = st.team === "player" ? 0x7ec8ff : 0xff8a7a;
      const pair = this.ensureHpBarPair(g, "st", dims.h * buildT + 0.9, fg);
      this.setHpBarFrac(pair, st.maxHp > 0 ? st.hp / st.maxHp : 0);
      const prevHp = this.structurePrevHp.get(st.id);
      if (prevHp !== undefined && st.hp < prevHp - 0.25) {
        (g.userData as Record<string, unknown>)["hitPulse"] = 0.22;
      }
      this.structurePrevHp.set(st.id, st.hp);

      const plinthMesh = g.userData["plinthMesh"] as THREE.Mesh | undefined;
      if (plinthMesh) {
        const cam = this.camera.position;
        const dx = st.x - cam.x;
        const dz = st.z - cam.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        const t = Math.min(1, Math.max(0, (dist - 38) / 220));
        const mat = plinthMesh.material as THREE.MeshStandardMaterial;
        const base = st.team === "player" ? new THREE.Color(0x0a2844) : new THREE.Color(0x440808);
        const peak = st.team === "player" ? new THREE.Color(0x55aaff) : new THREE.Color(0xff5555);
        mat.emissive.copy(base).lerp(peak, t);
        mat.emissiveIntensity = 0.35 + t * 0.95;
      }
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
        const dims = structureDims(entry && isStructureEntry(entry) ? entry : null);
        const hover = 0.2 * Math.sin(elapsed * 3);
        cube.position.set(st.x, dims.h + 1.4 + hover, st.z);
        cube.rotation.y = elapsed * 0.9;
        cube.visible = true;
      } else if (cube) {
        cube.visible = false;
      }
    }
  }

  private hideStructureSelectionVisuals(): void {
    if (this.selectHalo) this.selectHalo.visible = false;
    if (this.attackRangeRing) this.attackRangeRing.visible = false;
    if (this.auraRangeRing) this.auraRangeRing.visible = false;
    if (this.rallyLine) this.rallyLine.visible = false;
    if (this.rallyFlag) this.rallyFlag.visible = false;
  }

  private hideUnitSelectionVisuals(): void {
    if (this.unitSelHalo) this.unitSelHalo.visible = false;
    if (this.unitMeleeRing) this.unitMeleeRing.visible = false;
  }

  private syncSelectionAndRally(state: GameState): void {
    const uSel = state.selectedUnitId ?? state.selectedUnitIds[0] ?? null;
    const selU = uSel !== null ? state.units.find((x) => x.id === uSel) : null;
    const plrUnit = selU && selU.team === "player" && selU.hp > 0 ? selU : null;

    if (plrUnit) {
      this.hideStructureSelectionVisuals();
      const ux = plrUnit.x;
      const uz = plrUnit.z;
      const atkR = plrUnit.range;
      if (!this.unitSelHalo) {
        this.unitSelHalo = new THREE.Mesh(
          new THREE.RingGeometry(0.52, 0.92, 36),
          new THREE.MeshBasicMaterial({
            color: 0x9ed8ff,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.72,
            depthWrite: false,
            depthTest: false,
            blending: THREE.AdditiveBlending,
          }),
        );
        this.unitSelHalo.rotation.x = -Math.PI / 2;
        this.markers.add(this.unitSelHalo);
      }
      this.unitSelHalo.position.set(ux, 0.045, uz);
      this.unitSelHalo.visible = true;
      if (!this.unitMeleeRing) {
        this.unitMeleeRing = new THREE.Mesh(
          new THREE.RingGeometry(Math.max(0.15, atkR - 0.12), atkR, 56),
          new THREE.MeshBasicMaterial({
            color: 0x7ec8ff,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.26,
            depthWrite: false,
            depthTest: false,
            blending: THREE.AdditiveBlending,
          }),
        );
        this.unitMeleeRing.rotation.x = -Math.PI / 2;
        this.markers.add(this.unitMeleeRing);
      }
      this.unitMeleeRing.geometry.dispose();
      this.unitMeleeRing.geometry = new THREE.RingGeometry(
        Math.max(0.15, atkR - 0.12),
        atkR,
        56,
      );
      this.unitMeleeRing.position.set(ux, 0.052, uz);
      this.unitMeleeRing.visible = true;
      return;
    }

    this.hideUnitSelectionVisuals();

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
            depthTest: false,
            blending: THREE.AdditiveBlending,
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
              depthTest: false,
              blending: THREE.AdditiveBlending,
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
                color: 0x6ab8ff,
                side: THREE.DoubleSide,
                transparent: true,
                opacity: 0.24,
                depthWrite: false,
                depthTest: false,
                blending: THREE.AdditiveBlending,
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
              depthWrite: false,
              depthTest: false,
              blending: THREE.AdditiveBlending,
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
        this.rallyFlag.rotation.y = Math.atan2(st.rallyX - st.x, st.rallyZ - st.z);
        this.rallyFlag.visible = true;
      } else {
        if (this.rallyLine) this.rallyLine.visible = false;
        if (this.rallyFlag) this.rallyFlag.visible = false;
      }
    } else {
      this.hideStructureSelectionVisuals();
    }
  }

  private syncWorldPlane(state: GameState): void {
    const half = state.map.world.halfExtents + 28;
    if (this.worldPlaneHalf === half) return;
    this.worldPlaneHalf = half;
    const size = half * 2;
    this.ground.geometry.dispose();
    this.ground.geometry = new THREE.PlaneGeometry(size, size);
    this.groundOverlay.geometry.dispose();
    this.groundOverlay.geometry = new THREE.PlaneGeometry(size, size);
    this.groundVisualKey = "";
  }

  /** Fog, lighting tint, and procedural ground shader from `map.visual`. */
  private applyMapVisual(state: GameState): void {
    const v = state.map.visual;
    const preset = v?.groundPreset ?? "solid";
    const fogH = v?.fogHex;
    const skyH = v?.skyHex;
    const sunH = v?.sunHex;
    const key = `${preset}|${fogH ?? ""}|${skyH ?? ""}|${sunH ?? ""}`;
    if (key !== this.groundVisualKey) {
      this.groundVisualKey = key;
      if (fogH != null) {
        this.scene.fog = new THREE.Fog(fogH, v?.fogNear ?? 200, v?.fogFar ?? 960);
      } else {
        this.scene.fog = null;
      }
      if (skyH != null) this.hemiLight.color.setHex(skyH);
      if (sunH != null) this.sunLight.color.setHex(sunH);

      const disposeGroundMat = (): void => {
        const m = this.ground.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else (m as THREE.Material).dispose?.();
      };

      if (preset === "solid" || !isShaderGroundPreset(preset)) {
        disposeGroundMat();
        this.ground.material = new THREE.MeshStandardMaterial({
          color: 0x1b2430,
          roughness: 0.92,
          metalness: 0.04,
        });
      } else {
        disposeGroundMat();
        this.ground.material = createGroundShaderMaterial(preset);
      }
    }
    this.groundOverlay.visible = true;
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

  private setHpBarPairVisible(parent: THREE.Object3D, key: string, visible: boolean): void {
    const ud = parent.userData as Record<string, unknown>;
    const bg = ud[`${key}_hpBg`] as THREE.Mesh | undefined;
    const fg = ud[`${key}_hpFg`] as THREE.Mesh | undefined;
    if (bg) bg.visible = visible;
    if (fg) fg.visible = visible;
  }

  private syncMapDecor(state: GameState): void {
    if (this.decorBuilt) return;
    this.decorBuilt = true;
    const blockingColor = (() => {
      switch (state.map.visual?.groundPreset) {
        case "ember_wastes":
          return 0x723f2c;
        case "glacier_grid":
          return 0x466b7f;
        case "mesa_band":
          return 0x806044;
        default:
          return 0x3a4657;
      }
    })();
    for (const d of state.map.decor ?? []) {
      let mesh: THREE.Mesh | null = null;
      const color = d.blocksMovement ? blockingColor : d.color;
      const baseColor = color ?? 0x3a4657;
      const accentMat = new THREE.MeshStandardMaterial({
        color: hsl(baseColor, d.blocksMovement ? 0.12 : 0.08),
        roughness: 0.7,
        metalness: d.blocksMovement ? 0.16 : 0.08,
      });
      const shadowMat = new THREE.MeshStandardMaterial({
        color: hsl(baseColor, -0.16),
        roughness: 0.95,
        metalness: 0.02,
      });
      if (d.kind === "box") {
        mesh = new THREE.Mesh(
          new THREE.BoxGeometry(d.w * 0.96, d.h, d.d * 0.96),
          new THREE.MeshStandardMaterial({
            color: baseColor,
            roughness: 0.9,
            metalness: 0.04,
          }),
        );
        mesh.position.set(d.x, d.h / 2, d.z);
        mesh.rotation.y = ((d.rotYDeg ?? 0) * Math.PI) / 180;
        const cap = new THREE.Mesh(new THREE.BoxGeometry(d.w * 0.82, Math.min(0.34, d.h * 0.08), d.d * 0.82), accentMat);
        cap.position.y = d.h * 0.5 + Math.min(0.18, d.h * 0.04);
        const base = new THREE.Mesh(new THREE.BoxGeometry(d.w * 1.06, Math.min(0.28, d.h * 0.08), d.d * 1.06), shadowMat);
        base.position.y = -d.h * 0.5 + Math.min(0.14, d.h * 0.04);
        mesh.add(cap, base);
        if (d.blocksMovement) {
          const railW = Math.min(0.26, Math.max(0.08, Math.min(d.w, d.d) * 0.08));
          const railA = new THREE.Mesh(new THREE.BoxGeometry(d.w * 0.9, railW, railW), accentMat);
          const railB = railA.clone();
          railA.position.set(0, d.h * 0.18, d.d * 0.5);
          railB.position.set(0, d.h * 0.18, -d.d * 0.5);
          mesh.add(railA, railB);
        }
      } else if (d.kind === "cylinder") {
        mesh = new THREE.Mesh(
          new THREE.CylinderGeometry(d.radius, d.radius, d.h, 18),
          new THREE.MeshStandardMaterial({
            color: color ?? 0x4a4d5f,
            roughness: 0.85,
            metalness: 0.05,
          }),
        );
        mesh.position.set(d.x, d.h / 2, d.z);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(d.radius * 1.02, Math.max(0.035, d.radius * 0.06), 8, 28), accentMat);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = d.h * 0.5 + 0.04;
        mesh.add(ring);
      } else if (d.kind === "sphere") {
        const r = d.radius;
        const cy = d.y ?? r;
        mesh = new THREE.Mesh(
          new THREE.SphereGeometry(r, 20, 16),
          new THREE.MeshStandardMaterial({
            color: color ?? 0x5a6270,
            roughness: 0.78,
            metalness: 0.12,
          }),
        );
        mesh.position.set(d.x, cy, d.z);
        const chip = new THREE.Mesh(new THREE.IcosahedronGeometry(r * 0.28, 0), accentMat);
        chip.position.set(r * 0.18, r * 0.4, -r * 0.24);
        mesh.add(chip);
      } else if (d.kind === "cone") {
        mesh = new THREE.Mesh(
          new THREE.ConeGeometry(d.radius, d.h, 14),
          new THREE.MeshStandardMaterial({
            color: color ?? 0x4d5a68,
            roughness: 0.88,
            metalness: 0.06,
          }),
        );
        mesh.position.set(d.x, d.h / 2, d.z);
        mesh.rotation.y = ((d.rotYDeg ?? 0) * Math.PI) / 180;
        const skirt = new THREE.Mesh(new THREE.CylinderGeometry(d.radius * 1.02, d.radius * 1.1, Math.max(0.12, d.h * 0.06), 14), shadowMat);
        skirt.position.y = -d.h * 0.5 + Math.max(0.06, d.h * 0.03);
        mesh.add(skirt);
      } else if (d.kind === "torus") {
        mesh = new THREE.Mesh(
          new THREE.TorusGeometry(d.radius, d.tube, 14, 40),
          new THREE.MeshStandardMaterial({
            color: color ?? 0x3d4555,
            roughness: 0.8,
            metalness: 0.18,
          }),
        );
        mesh.rotation.x = -Math.PI / 2;
        mesh.rotation.y = ((d.rotYDeg ?? 0) * Math.PI) / 180;
        mesh.position.set(d.x, d.tube * 0.5 + 0.02, d.z);
        const core = new THREE.Mesh(new THREE.CylinderGeometry(d.radius * 0.36, d.radius * 0.42, d.tube * 0.75, 18), shadowMat);
        core.position.y = -d.tube * 0.12;
        mesh.add(core);
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
        const tex = orb.userData["coreTexture"] as THREE.Texture | undefined;
        tex?.dispose();
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
        const tex = makeEnemyCoreTexture();
        orb = new THREE.Mesh(
          new THREE.IcosahedronGeometry(1, 3),
          new THREE.MeshStandardMaterial({
            color: 0xb83a32,
            map: tex,
            emissive: 0x2a0610,
            emissiveMap: tex,
            emissiveIntensity: 0.45,
            roughness: 0.82,
            metalness: 0.02,
            transparent: true,
            opacity: 0.82,
          }),
        );
        orb.userData["coreTexture"] = tex;
        this.markers.add(orb);
        this.coreOrbs.set(campId, orb);
      }
      const breathe = 0.08 * Math.sin(elapsed * 2.4);
      const r = 0.58 + frac * 1.02 + breathe;
      orb.scale.setScalar(r);
      orb.position.set(camp.origin.x, 1.55 + breathe * 0.45, camp.origin.z);
      orb.rotation.y = elapsed * 0.35;
      orb.rotation.x = Math.sin(elapsed * 0.5) * 0.08;
      const mat = orb.material as THREE.MeshStandardMaterial;
      mat.opacity = 0.5 + 0.34 * frac;
      mat.emissiveIntensity = 0.18 + 0.45 * frac;
    }
  }

  private syncTerritory(state: GameState): void {
    this.syncTerritoryTeam("player", territorySources(state), 0x56c9ff, 0.18);
    this.syncTerritoryTeam("enemy", enemyTerritorySources(state), 0xff5d54, 0.13);
  }

  private territorySourceKey(sources: { x: number; z: number }[]): string {
    return `${this.worldPlaneHalf.toFixed(1)}|${sources.map((p) => `${p.x.toFixed(1)},${p.z.toFixed(1)}`).join("|")}`;
  }

  private syncTerritoryTeam(
    team: "player" | "enemy",
    sources: { x: number; z: number }[],
    color: number,
    opacity: number,
  ): void {
    const key = this.territorySourceKey(sources);
    const oldKey = team === "player" ? this.territoryKey : this.enemyTerritoryKey;
    if (key === oldKey) return;
    if (team === "player") this.territoryKey = key;
    else this.enemyTerritoryKey = key;

    this.disposeTerritoryTeam(team);
    if (sources.length === 0) return;

    const half = Math.max(this.worldPlaneHalf, TERRITORY_RADIUS * 2);
    const texture = this.createTerritoryTexture(sources, half);
    const field = new THREE.Mesh(
      new THREE.PlaneGeometry(half * 2, half * 2),
      new THREE.MeshBasicMaterial({
        color,
        map: texture,
        transparent: true,
        opacity,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
      }),
    );
    field.rotation.x = -Math.PI / 2;
    field.position.y = team === "player" ? 0.055 : 0.052;
    field.renderOrder = -6;

    const outline = this.createTerritoryOutline(sources, color, team === "player" ? 0.78 : 0.52);
    if (outline) this.territoryGroup.add(outline);
    this.territoryGroup.add(field);

    if (team === "player") {
      this.territoryField = field;
      this.territoryTexture = texture;
      this.territoryOutline = outline;
    } else {
      this.enemyTerritoryField = field;
      this.enemyTerritoryTexture = texture;
      this.enemyTerritoryOutline = outline;
    }
  }

  private disposeTerritoryTeam(team: "player" | "enemy"): void {
    const field = team === "player" ? this.territoryField : this.enemyTerritoryField;
    const texture = team === "player" ? this.territoryTexture : this.enemyTerritoryTexture;
    const outline = team === "player" ? this.territoryOutline : this.enemyTerritoryOutline;
    if (field) {
      this.territoryGroup.remove(field);
      field.geometry.dispose();
      (field.material as THREE.Material).dispose();
    }
    if (texture) texture.dispose();
    if (outline) {
      this.territoryGroup.remove(outline);
      outline.geometry.dispose();
      (outline.material as THREE.Material).dispose();
    }
    if (team === "player") {
      this.territoryField = null;
      this.territoryTexture = null;
      this.territoryOutline = null;
    } else {
      this.enemyTerritoryField = null;
      this.enemyTerritoryTexture = null;
      this.enemyTerritoryOutline = null;
    }
  }

  private createTerritoryTexture(sources: { x: number; z: number }[], half: number): THREE.CanvasTexture {
    const size = 512;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = "rgba(255,255,255,1)";
    const scale = size / (half * 2);
    const radius = TERRITORY_RADIUS * scale;
    for (const p of sources) {
      const cx = (p.x + half) * scale;
      const cy = (half - p.z) * scale;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }

  private createTerritoryOutline(
    sources: { x: number; z: number }[],
    color: number,
    opacity: number,
  ): THREE.LineSegments | null {
    const positions: number[] = [];
    const segs = 96;
    const r = TERRITORY_RADIUS;
    const coverR2 = (r - 1.5) * (r - 1.5);
    for (let si = 0; si < sources.length; si++) {
      const p = sources[si]!;
      for (let i = 0; i < segs; i++) {
        const a0 = (i / segs) * Math.PI * 2;
        const a1 = ((i + 1) / segs) * Math.PI * 2;
        const am = (a0 + a1) * 0.5;
        const mx = p.x + Math.cos(am) * r;
        const mz = p.z + Math.sin(am) * r;
        let covered = false;
        for (let sj = 0; sj < sources.length; sj++) {
          if (sj === si) continue;
          const o = sources[sj]!;
          const dx = mx - o.x;
          const dz = mz - o.z;
          if (dx * dx + dz * dz < coverR2) {
            covered = true;
            break;
          }
        }
        if (covered) continue;
        positions.push(p.x + Math.cos(a0) * r, 0.16, p.z + Math.sin(a0) * r);
        positions.push(p.x + Math.cos(a1) * r, 0.16, p.z + Math.sin(a1) * r);
      }
    }
    if (positions.length === 0) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      depthTest: true,
    });
    const line = new THREE.LineSegments(geo, mat);
    line.renderOrder = -5;
    return line;
  }

  private buildHeroMesh(): THREE.Group {
    const g = new THREE.Group();
    g.scale.setScalar(1.2);
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
        depthTest: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04;
    g.add(ring);

    return g;
  }

  private buildRivalHeroMesh(): THREE.Group {
    const g = new THREE.Group();
    g.scale.setScalar(1.2);
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
        depthTest: false,
        blending: THREE.AdditiveBlending,
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
        this.startUnitDeathVisual(obj);
        this.unitMeshes.delete(id);
        this.unitCountLabels.delete(id);
        this.unitPrevAttackTick.delete(id);
        this.unitPrevPos.delete(id);
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
            void requestGlbForUnit(u.sizeClass, placeholder, u.team);
          }
        }
      }
      obj.position.set(u.x, 0, u.z);
      const g = obj as THREE.Group;
      g.userData["unitId"] = u.id;
      g.userData["team"] = u.team;
      const hpFrac = u.maxHp > 0 ? u.hp / u.maxHp : 0;
      const selected = state.selectedUnitIds.includes(u.id);
      const h = unitMeshLinearSize(u.sizeClass) * 1.22;
      g.userData["unitHeight"] = h;
      const fg = u.team === "player" ? 0x7ec8ff : 0xff8888;
      const pair = this.ensureHpBarPair(g, "u", h, fg);
      this.setHpBarFrac(pair, hpFrac);
      const fgMat = pair.fg.material as THREE.MeshBasicMaterial;
      if (hpFrac < 0.25) fgMat.color.set(0xff4040);
      else if (hpFrac < 0.55) fgMat.color.set(0xffc247);
      else fgMat.color.set(fg);
      fgMat.opacity = selected || hpFrac < 0.995 ? 0.98 : 0.56;
      (pair.bg.material as THREE.MeshBasicMaterial).opacity = selected || hpFrac < 0.995 ? 0.82 : 0.42;
      this.setHpBarPairVisible(g, "u", true);
      let label = this.unitCountLabels.get(u.id);
      if (!label) {
        label = makeLabelSprite("x1", u.team === "player" ? "#7ec8ff" : "#ff8888");
        label.sprite.scale.set(3.2, 0.9, 1);
        g.add(label.sprite);
        this.unitCountLabels.set(u.id, label);
      }
      label.sprite.position.set(0, h + 0.72, 0);
      const liveCount = liveSquadCount(u);
      const maxCount = Math.max(1, u.squadMaxCount ?? u.squadCount ?? 1);
      const countText = maxCount > 1 ? `x${liveCount}` : "";
      drawLabel(label, countText, u.team === "player" ? "#7ec8ff" : "#ff8888");
      label.sprite.visible = maxCount > 1;
      const prevHp = this.unitPrevHp.get(u.id);
      if (prevHp !== undefined && u.hp < prevHp - 0.25) {
        (g.userData as Record<string, unknown>)["hitPulse"] = 0.22;
      }
      this.unitPrevHp.set(u.id, u.hp);
      const attackTick = u.lastAttackTick;
      const prevAttackTick = this.unitPrevAttackTick.get(u.id);
      if (attackTick !== undefined && attackTick !== prevAttackTick) this.playGlbAttackAnimation(g);
      if (attackTick !== undefined) this.unitPrevAttackTick.set(u.id, attackTick);
      const useIdle = u.order?.mode === "stay";
      this.setGlbMoveAnimation(g, !useIdle);
      this.unitPrevPos.set(u.id, new THREE.Vector2(u.x, u.z));
    }
  }

  private orientHpBars(): void {
    const cam = this.camera.position;
    const orient = (root: THREE.Object3D): void => {
      const ud = root.userData as Record<string, unknown>;
      for (const key of ["u", "st", "relay", "tapA"] as const) {
        const bg = ud[`${key}_hpBg`] as THREE.Mesh | undefined;
        const fg = ud[`${key}_hpFg`] as THREE.Mesh | undefined;
        if (bg) bg.lookAt(cam);
        if (fg) fg.lookAt(cam);
      }
    };
    for (const g of this.unitMeshes.values()) orient(g);
    for (const g of this.structureMeshes.values()) orient(g);
    for (const m of this.relayMeshes.values()) orient(m);
    for (const g of this.tapAnchorRoots.values()) orient(g);
    if (this.heroGroup && this.heroHpBarBg && this.heroHpBarFg) {
      this.heroHpBarBg.lookAt(cam);
      this.heroHpBarFg.lookAt(cam);
    }
    if (this.enemyHeroGroup && this.enemyHeroHpBarBg && this.enemyHeroHpBarFg) {
      this.enemyHeroHpBarBg.lookAt(cam);
      this.enemyHeroHpBarFg.lookAt(cam);
    }
  }

  /** Lock mode: move orbit pivot with the hero; camera moves by the same delta so zoom (scroll) is unchanged. */
  private applyHeroCameraFollow(dt: number): void {
    if (!this.cameraFollowHero && this.cameraFollowUnitId === null) return;
    this.nudgeCameraRigTowardFollowPivot(dt);
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
    for (const g of this.tapAnchorRoots.values()) pulse(g);
    if (this.enemyHeroGroup) pulse(this.enemyHeroGroup);
  }

  private tickGlbAnimations(dt: number): void {
    const unitCount = this.unitMeshes.size;
    const interval = unitCount >= 700 ? 1 / 15 : unitCount >= 240 ? 1 / 20 : unitCount >= 90 ? 1 / 30 : 0;
    this.glbAnimationAccumSec += dt;
    const shouldUpdateMixers = interval === 0 || this.glbAnimationAccumSec >= interval;
    const mixerDt = interval === 0 ? dt : this.glbAnimationAccumSec;
    if (shouldUpdateMixers) this.glbAnimationAccumSec = 0;

    let clampBudget = unitCount >= 240 ? 2 : unitCount >= 90 ? 4 : 10;
    const tick = (root: THREE.Object3D | null, allowClamp: boolean): void => {
      const ud = root?.userData as Record<string, unknown> | undefined;
      const mixer = ud?.["glbMixer"] as THREE.AnimationMixer | undefined;
      if (mixer && shouldUpdateMixers) mixer.update(mixerDt);
      const clampChecks = (ud?.["glbClampChecksRemaining"] as number | undefined) ?? 0;
      if (root && allowClamp && clampChecks > 0 && clampBudget > 0) {
        this.clampUnitGlbScale(root);
        ud!["glbClampChecksRemaining"] = clampChecks - 1;
        clampBudget--;
      }
      const timer = ud?.["glbAttackTimer"] as number | undefined;
      if (timer === undefined) return;
      const next = timer - dt;
      if (next > 0) {
        ud!["glbAttackTimer"] = next;
        return;
      }
      delete ud!["glbAttackTimer"];
      const attack = ud?.["glbAttackAction"] as THREE.AnimationAction | undefined;
      const run = ud?.["glbRunAction"] as THREE.AnimationAction | undefined;
      const idle = ud?.["glbIdleAction"] as THREE.AnimationAction | undefined;
      if (attack) attack.fadeOut(0.08);
      const nextBase = ud?.["glbBaseState"] === "idle" ? (idle ?? run) : run;
      if (nextBase) {
        nextBase.enabled = true;
        nextBase.play();
        nextBase.fadeIn(0.08);
      }
    };
    for (const g of this.unitMeshes.values()) tick(g, true);
    for (const g of this.structureMeshes.values()) tick(g, false);
    tick(this.heroGroup, false);
    tick(this.enemyHeroGroup, false);
    for (let i = this.dyingUnits.length - 1; i >= 0; i--) {
      const d = this.dyingUnits[i]!;
      tick(d.obj, false);
      const p = 1 - Math.max(0, Math.min(1, d.timer / d.life));
      this.applyUnitDissolve(d.obj, p);
      for (let j = 0; j < d.particles.length; j++) {
        const mote = d.particles[j]!;
        const mat = mote.material as THREE.MeshBasicMaterial;
        const drift = 0.05 + j * 0.018;
        mote.position.y += (0.38 + j * 0.08) * dt;
        mote.position.x += Math.sin(p * Math.PI + j * 1.7) * drift * dt;
        mote.position.z += Math.cos(p * Math.PI + j * 1.3) * drift * dt;
        mote.scale.setScalar(Math.max(0.02, 1 - p * 0.7));
        mat.opacity = 0.42 * (1 - p);
      }
      d.timer -= dt;
      if (d.timer > 0) continue;
      this.entities.remove(d.obj);
      this.disposeObject(d.obj);
      this.dyingUnits.splice(i, 1);
    }
  }

  private clampUnitGlbScale(root: THREE.Object3D): void {
    const ud = root.userData as Record<string, unknown>;
    const glb = ud["glbRoot"] as THREE.Object3D | undefined;
    const target = ud["glbTargetMaxExtent"] as number | undefined;
    if (!glb || !(typeof target === "number") || target <= 0) return;

    const box = this.localBoundsForObject(glb, root);
    if (box.isEmpty()) return;
    const size = new THREE.Vector3();
    box.getSize(size);
    const max = Math.max(size.x, size.y, size.z);
    if (!Number.isFinite(max) || max <= 1e-5) return;

    // Hard safety cage: animated unit art must never exceed its class target by much.
    // Meshy clips can include incompatible rig transforms; this keeps towers as the visual truth.
    if (max > target * 1.12) {
      glb.scale.multiplyScalar(target / max);
      glb.updateMatrixWorld(true);
    }

    const b2 = this.localBoundsForObject(glb, root);
    if (b2.isEmpty()) return;
    glb.position.x -= (b2.min.x + b2.max.x) / 2;
    glb.position.z -= (b2.min.z + b2.max.z) / 2;
    glb.position.y -= b2.min.y;
  }

  private localBoundsForObject(obj: THREE.Object3D, relativeTo: THREE.Object3D): THREE.Box3 {
    obj.updateMatrixWorld(true);
    relativeTo.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(relativeTo.matrixWorld).invert();
    const out = new THREE.Box3();
    const tmp = new THREE.Box3();
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.geometry) return;
      const skinned = m as THREE.SkinnedMesh;
      if (skinned.isSkinnedMesh) skinned.computeBoundingBox();
      else m.geometry.computeBoundingBox();
      const bb = skinned.isSkinnedMesh ? skinned.boundingBox : m.geometry.boundingBox;
      if (!bb) return;
      tmp.copy(bb).applyMatrix4(m.matrixWorld).applyMatrix4(inv);
      out.union(tmp);
    });
    return out;
  }

  private playGlbAttackAnimation(root: THREE.Object3D): void {
    const ud = root.userData as Record<string, unknown>;
    const attack = ud["glbAttackAction"] as THREE.AnimationAction | undefined;
    if (!attack) return;
    if (ud["glbAttackTimer"] !== undefined) return;
    const run = ud["glbRunAction"] as THREE.AnimationAction | undefined;
    const idle = ud["glbIdleAction"] as THREE.AnimationAction | undefined;
    const duration = Math.max(0.18, (ud["glbAttackDuration"] as number | undefined) ?? 0.65);
    if (run) run.fadeOut(0.08);
    if (idle) idle.fadeOut(0.08);
    attack.enabled = true;
    attack.reset();
    attack.setEffectiveWeight(1);
    attack.fadeIn(0.04);
    attack.play();
    ud["glbAttackTimer"] = duration;
    ud["glbClampChecksRemaining"] = Math.max((ud["glbClampChecksRemaining"] as number | undefined) ?? 0, 1);
  }

  private cloneMaterialsForDissolve(root: THREE.Object3D): void {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      if (mesh.userData["dissolveMaterialCloned"]) return;
      if (Array.isArray(mesh.material)) mesh.material = mesh.material.map((m) => m.clone());
      else mesh.material = mesh.material.clone();
      mesh.userData["dissolveMaterialCloned"] = true;
    });
  }

  private applyUnitDissolve(root: THREE.Object3D, p: number): void {
    const opacity = Math.max(0, 1 - p);
    const squash = Math.max(0.58, 1 - p * 0.24);
    root.scale.set(1 + p * 0.08, squash, 1 + p * 0.08);
    root.position.y = -p * 0.08;
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const raw of mats) {
        const mat = raw as THREE.Material & { opacity?: number; transparent?: boolean; depthWrite?: boolean };
        if (typeof mat.opacity !== "number") continue;
        mat.transparent = true;
        mat.depthWrite = false;
        mat.opacity = opacity;
      }
    });
  }

  private makeDeathMotes(root: THREE.Object3D): THREE.Mesh[] {
    const ud = root.userData as Record<string, unknown>;
    const team = ud["team"] === "enemy" ? "enemy" : "player";
    const color = team === "enemy" ? 0xff8a70 : 0x8fdcff;
    const motes: THREE.Mesh[] = [];
    const size = Math.max(0.05, ((ud["unitHeight"] as number | undefined) ?? 1.5) * 0.035);
    for (let i = 0; i < 4; i++) {
      const mote = new THREE.Mesh(
        new THREE.IcosahedronGeometry(size * (0.75 + i * 0.08), 0),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.42,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      const a = i * 2.399;
      const r = 0.12 + i * 0.035;
      mote.position.set(Math.cos(a) * r, 0.18 + i * 0.11, Math.sin(a) * r);
      root.add(mote);
      motes.push(mote);
    }
    return motes;
  }

  private startUnitDeathVisual(root: THREE.Object3D): void {
    const ud = root.userData as Record<string, unknown>;
    if (ud["unitDying"]) return;
    ud["unitDying"] = true;
    this.cloneMaterialsForDissolve(root);
    this.setHpBarPairVisible(root, "u", false);
    const label = this.unitCountLabels.get(ud["unitId"] as number);
    if (label) label.sprite.visible = false;
    const particles = this.makeDeathMotes(root);
    const life = 0.42;
    this.startGlbDeathAnimation(root);
    this.dyingUnits.push({ obj: root, timer: life, life, particles });
  }

  private startGlbDeathAnimation(root: THREE.Object3D): void {
    const ud = root.userData as Record<string, unknown>;
    const death = ud["glbDeathAction"] as THREE.AnimationAction | undefined;
    if (!death) return;
    for (const key of ["glbRunAction", "glbIdleAction", "glbAttackAction"] as const) {
      const a = ud[key] as THREE.AnimationAction | undefined;
      if (a) a.stop();
    }
    death.enabled = true;
    death.reset();
    death.setEffectiveWeight(1);
    death.play();
  }

  private setGlbMoveAnimation(root: THREE.Object3D, moving: boolean): void {
    const ud = root.userData as Record<string, unknown>;
    if (ud["glbAttackTimer"] !== undefined) return;
    const run = ud["glbRunAction"] as THREE.AnimationAction | undefined;
    const idle = ud["glbIdleAction"] as THREE.AnimationAction | undefined;
    if (!run) return;
    const next = moving ? "run" : "idle";
    if (ud["glbBaseState"] === next) return;
    const from = next === "run" ? idle : run;
    const to = next === "run" ? run : (idle ?? run);
    if (from && from !== to) from.fadeOut(0.12);
    to.enabled = true;
    to.play();
    to.fadeIn(0.12);
    ud["glbBaseState"] = next === "idle" && !idle ? "run" : next;
  }

  private updateAdaptiveBloom(dt: number): void {
    if (dt > 0.001) {
      const fps = 1 / dt;
      this.rollingFps = this.rollingFps * 0.94 + fps * 0.06;
    }
    const now = performance.now();
    if (now - this.bloomDecisionMs < 500) return;
    this.bloomDecisionMs = now;
    const state = this.currentState;
    const unitCount = state?.units.length ?? 0;
    const coarseInput = navigator.maxTouchPoints > 0 && Math.min(window.innerWidth, window.innerHeight) < 760;
    const mobileUA = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const heavyLoad = unitCount >= 700;
    const lowFps = this.rollingFps < 46;
    this.bloomEnabled = !!state && !coarseInput && !mobileUA && !heavyLoad && !lowFps;
    this.bloomPass.strength = unitCount > 420 ? 0.08 : 0.16;
    this.bloomPass.radius = unitCount > 420 ? 0.22 : 0.32;
    this.bloomPass.threshold = 0.88;
  }

  render(): void {
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - this.lastRenderFrameMs) / 1000));
    this.lastRenderFrameMs = now;
    this.updateAdaptiveBloom(dt);
    this.tickMatchIntroCinematic();
    this.applyHeroCameraFollow(dt);
    this.controls.update();
    this.tickGlbAnimations(dt);
    this.tickHitPulses(dt);
    this.orientHpBars();
    stepFx(this.fx, dt);
    if (this.bloomEnabled) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
    this.heroLungeTimer = Math.max(0, this.heroLungeTimer - dt);
  }
}
