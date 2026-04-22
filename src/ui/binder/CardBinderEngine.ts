import * as THREE from "three";
import { DOCTRINE_SLOT_COUNT } from "../../game/constants";
import { TCG_FULL_CARD_H, TCG_FULL_CARD_W } from "../tcgCardPrint";
import { createBinderCardBackTexture } from "./binderCardBackTexture";
import {
  BINDER_FULLY_OPEN_PROGRESS,
  deriveBinderUiMode,
  interactionMayArmPageTurn,
  interactionMayPickCatalog,
  type BinderUiMode,
} from "./binderInteractionState";
import { composeCardIntoBinderSleeve } from "./binderSleeveComposite";
import { BinderPageAudio } from "./binderPageAudio";
import { createGrimoireCoverTexture } from "./binderTomeArt";

/** Binder layout + flip physics (ported from CardBinder.jsx). */
export const BINDER_CFG = {
  pageWidth: 2.1,
  pageHeight: 2.85,
  seamGap: 0.04,
  seamFlex: 0.18,
  rowDroop: 0.06,
  /** Snappier settle + slightly less overshoot than legacy defaults. */
  springStiff: 96,
  springDamp: 14.5,
  panelTexW: 400,
  /** Scene clear — parchment (never “void black” at grazing angles). */
  bg: 0xebe4d8,
} as const;

/** 3×3 cells per page (matches catalog binder reference: nine sleeves per face). */
export const BINDER_COLS = 3;
export const BINDER_ROWS = 3;
export const BINDER_CELLS_PER_PAGE = BINDER_COLS * BINDER_ROWS;

/**
 * @deprecated Unused — codex length is fixed by `BINDER_CODEX_SPREAD_COUNT`.
 */
export const BINDER_TEST_EXTRA_PAGES = 0;

/** Doctrine codex: always this many spreads (empty sleeves pad the catalog). */
export const BINDER_CODEX_SPREAD_COUNT = 9;

export type CardBinderEngineOptions = {
  /** @deprecated Shell is always on (CardBinder.html); kept for API compatibility. */
  showLeatherBackdrop?: boolean;
};

const colW = (BINDER_CFG.pageWidth - BINDER_CFG.seamGap * 2) / BINDER_COLS;
const rowH = (BINDER_CFG.pageHeight - BINDER_CFG.seamGap * 2) / BINDER_ROWS;

/** Full-card DOM raster matches `binderCardTexture` / doctrine print size. */
export function binderPanelPixelSize(): { w: number; h: number } {
  return { w: TCG_FULL_CARD_W, h: TCG_FULL_CARD_H };
}

/** Folio paper / magnet grid sits slightly in front of the leather deck. */
const PAGE_SURFACE_Z = -0.005;
/**
 * Page flip hinge: `fp` rotates about **world Y** through origin. Layout places the gutter near **x = 0**
 * (`_cellLocalX`); tweak `fp.position.x` only if shell art and rings need alignment.
 */
const FLIP_LEAF_HINGE_X = 0;
const FLIP_LEAF_Z_EPS = 0.012;
const UNDER_PAGE_Z_LIFT = 0.004;
/**
 * Duplex “magnet” slot: recto + verso are parallel planes with a tiny symmetric gap (no pocket, no per-recto lift).
 * Each page is a 3×3 grid of these slots; the turning leaf is the same rigid geometry, only the whole `fp` rotates.
 */
const MAGNET_FACE_GAP = 0.0022;
/** Slight per-slot Z bias so nine coplanar quads rarely z-fight in the depth buffer. */
const MAGNET_SLOT_Z_STAGGER = 0.0001;

/** RMB-orbit: keep the camera in front of the folio (pages lie in XY); unbounded yaw looks straight through the card planes. */
const BINDER_ORBIT_YAW_LIMIT = 0.76;
const BINDER_ORBIT_PITCH_MIN = -0.48;
const BINDER_ORBIT_PITCH_MAX = 0.4;

function dragAngleShaped(raw: number): number {
  const r = THREE.MathUtils.clamp(raw, 0, Math.PI);
  const t = r / Math.PI;
  const s = t * t * (3.0 - 2.0 * t);
  return Math.PI * THREE.MathUtils.lerp(t, s, 0.38);
}

/** Empty sleeve panel — same 2D treatment as catalog cards. */
export function makeEmptyBinderPanelCanvas(): HTMLCanvasElement {
  return composeCardIntoBinderSleeve(null);
}

function makeEmptyTexture(): THREE.CanvasTexture {
  const c = makeEmptyBinderPanelCanvas();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Shared leather look for shell + hinged front cover (Phase B). */
function createProceduralLeatherTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 512;
  const g = c.getContext("2d")!;
  const gr = g.createRadialGradient(256, 256, 60, 256, 256, 340);
  gr.addColorStop(0, "#5c2e1a");
  gr.addColorStop(0.6, "#3d1d10");
  gr.addColorStop(1, "#230f07");
  g.fillStyle = gr;
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 3000; i++) {
    g.fillStyle = Math.random() < 0.5 ? "#7a4026" : "#1c0a04";
    g.fillRect(Math.random() * 512, Math.random() * 512, 1 + Math.random() * 1.3, 1 + Math.random() * 1.3);
  }
  g.strokeStyle = "rgba(20,8,3,.4)";
  g.lineWidth = 1;
  for (let i = 0; i < 30; i++) {
    g.beginPath();
    let x = Math.random() * 512;
    let y = Math.random() * 512;
    g.moveTo(x, y);
    for (let k = 0; k < 15; k++) {
      x += (Math.random() - 0.5) * 18;
      y += (Math.random() - 0.5) * 18;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  const vg = g.createRadialGradient(256, 256, 80, 256, 256, 380);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, "rgba(12,4,2,0.42)");
  g.save();
  g.globalCompositeOperation = "multiply";
  g.fillStyle = vg;
  g.fillRect(0, 0, 512, 512);
  g.restore();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function easeOutCubic(t: number): number {
  const u = Math.max(0, Math.min(1, t));
  return 1 - (1 - u) ** 3;
}

export class CardBinderEngine {
  readonly R: THREE.WebGLRenderer;
  readonly S: THREE.Scene;
  readonly cam: THREE.PerspectiveCamera;
  readonly G: THREE.Group;
  /** Leather back + spine — reads as the outer tome block behind the folio. */
  private readonly tomeBackGroup = new THREE.Group();
  private readonly shellGroup: THREE.Group;
  /** D-ring hardware (scaled in as the cover opens). */
  private readonly ringMechanismGroup = new THREE.Group();
  /** Pages, margins — hidden while the tome is closed. */
  private readonly innerGroup: THREE.Group;
  private readonly coverHinge = new THREE.Group();
  private coverBoard: THREE.Mesh | null = null;
  private coverHit: THREE.Mesh | null = null;
  private _coverBoardMat: THREE.MeshStandardMaterial | null = null;
  private _coverDecoTex: THREE.CanvasTexture | null = null;
  private _coverDecoMat: THREE.MeshStandardMaterial | null = null;
  private readonly _coverMetalMaterials: THREE.MeshStandardMaterial[] = [];
  private readonly _sharedLeatherTex: THREE.CanvasTexture;
  private readonly _shellMaterials: THREE.MeshStandardMaterial[] = [];
  private readonly _ownedLights: THREE.Light[] = [];
  private readonly pg: THREE.PlaneGeometry;
  private etex: THREE.CanvasTexture;
  private readonly cardBackTex: THREE.CanvasTexture;
  private ctex: THREE.Texture[];
  /** Nine catalog indices per logical page (`ceil(n / 9)` pages). */
  private chunks: number[][];
  private cur = 0;
  private fl = 0;
  private ang = 0;
  private vel = 0;
  private tgt: number | null = null;
  private lp: THREE.Group | null = null;
  private rp: THREE.Group | null = null;
  private fp: THREE.Group | null = null;
  private drag = false;
  private dSX = 0;
  private dSA = 0;
  private orb = false;
  private oSX = 0;
  private oSY = 0;
  private oSY2 = 0;
  private oSP = 0;
  private readonly clock = new THREE.Clock();
  private disposed = false;
  private dist = 5.8;
  private yaw = 0;
  private pitch = -0.15;
  private doctrOrder: string[] = [];
  private doctrSlots: (string | null)[] = Array.from({ length: DOCTRINE_SLOT_COUNT }, () => null);
  private doctrActive: number | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();

  onPageChange: ((page: number, total: number) => void) | null = null;
  onPickCatalogIndex: ((index: number | null) => void) | null = null;
  /** Fires when the binder crosses between closed and fully open (for UI hints). */
  onOpenStateChange: ((isOpen: boolean) => void) | null = null;

  private flipArm: "next" | "prev" | null = null;
  private armSX = 0;
  private armSY = 0;
  /** Pointer down began on a recto card cell — blocks page-turn arming; large move cancels tap. */
  private pendingCardTap = false;
  private readonly FLIP_ARM_PX = 10;
  private readonly TAP_MAX_PX = 14;
  /** 0 = closed tome, 1 = fully open binder; animated toward `openingTarget`. */
  private openingProgress = 0;
  private openingTarget: number | null = null;
  private coverTapArmed = false;
  private _lastNotifiedOpen = false;
  private readonly marginHitGroup = new THREE.Group();
  private _marginMat: THREE.MeshBasicMaterial | null = null;
  private _pickDebounceHandle: ReturnType<typeof globalThis.setTimeout> | null = null;
  private readonly pageAudio: BinderPageAudio;
  /** Full two-page parchment behind `lp`/`rp` so the folio never reads as the scene clear color. */
  private readonly folioPaperMesh: THREE.Mesh;
  /** Pointer horizontal speed (normalized) during page drag — used on release for flick commit. */
  private pointerVxNorm = 0;
  private lastMoveClientX = 0;
  private lastMoveT = 0;
  private _lastMechTe = 0;
  private _metalTickDoneForOpen = false;
  /** Shared thin quads faking page block thickness under static spreads. */
  private readonly paperStackGeo: THREE.PlaneGeometry;

  constructor(canvas: HTMLCanvasElement, textures: THREE.Texture[], _opts?: CardBinderEngineOptions) {
    this.pageAudio = new BinderPageAudio();

    this.R = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    this.R.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.R.outputColorSpace = THREE.SRGBColorSpace;
    this.R.toneMapping = THREE.ACESFilmicToneMapping;
    /** Leather shell only — catalog panels use `toneMapped:false` so ACES + high exposure cannot crush sleeve art to black. */
    this.R.toneMappingExposure = 1.02;
    this.R.setClearColor(BINDER_CFG.bg, 1);

    this.S = new THREE.Scene();
    this.S.background = new THREE.Color(BINDER_CFG.bg);
    this.cam = new THREE.PerspectiveCamera(40, 1, 0.1, 100);

    const addLight = (L: THREE.Light): void => {
      this.S.add(L);
      this._ownedLights.push(L);
    };

    addLight(new THREE.AmbientLight(0xfff5ec, 0.62));
    /** Open folio: cool skylight vs warm desk bounce. */
    addLight(new THREE.HemisphereLight(0xc8d6f0, 0x4a3020, 0.2));
    const d1 = new THREE.DirectionalLight(0xfff8ee, 1.12);
    d1.position.set(1, 3, 4);
    addLight(d1);
    const d2 = new THREE.DirectionalLight(0xddeeff, 0.4);
    d2.position.set(-2, 1, 3);
    addLight(d2);
    const d3 = new THREE.DirectionalLight(0x8899cc, 0.3);
    d3.position.set(0, -1, -3);
    addLight(d3);
    const spine = new THREE.PointLight(0xffecd8, 0.28, 11);
    spine.position.set(0.15, 0.25, 1.15);
    addLight(spine);

    this.G = new THREE.Group();
    this.S.add(this.G);

    this._sharedLeatherTex = createProceduralLeatherTexture();

    this.tomeBackGroup.name = "binder_tome_back";
    this.tomeBackGroup.renderOrder = -30;
    this.G.add(this.tomeBackGroup);
    this._addTomeBackPlate(this.tomeBackGroup, this._sharedLeatherTex);

    this.shellGroup = new THREE.Group();
    this.shellGroup.name = "binder_ring_shell";
    this.shellGroup.renderOrder = -30;
    this.G.add(this.shellGroup);
    this.ringMechanismGroup.name = "binder_three_ring_mechanism";
    this.ringMechanismGroup.renderOrder = -28;
    this.shellGroup.add(this.ringMechanismGroup);
    this._addRingBinderMechanism(this.shellGroup, this.ringMechanismGroup, this._sharedLeatherTex);

    this.innerGroup = new THREE.Group();
    this.innerGroup.name = "binder_inner_pages";
    /** Pull folio + cards **in front of** leather shell / rings in Z so nothing can paint over sleeves (depth + sort). */
    this.innerGroup.position.z = 0.065;
    this.innerGroup.renderOrder = 40;
    this.G.add(this.innerGroup);

    {
      const PW = BINDER_CFG.pageWidth;
      const PH = BINDER_CFG.pageHeight;
      const spreadW = PW * 2 + BINDER_CFG.seamGap * 2 + 0.14;
      const spreadH = PH + 0.1;
      const geo = new THREE.PlaneGeometry(spreadW, spreadH);
      const mat = new THREE.MeshBasicMaterial({
        color: 0xede6dc,
        transparent: false,
        toneMapped: false,
        depthWrite: true,
        depthTest: true,
      });
      this.folioPaperMesh = new THREE.Mesh(geo, mat);
      this.folioPaperMesh.name = "binder_folio_paper";
      this.folioPaperMesh.position.set(0, 0, PAGE_SURFACE_Z - 0.026);
      this.folioPaperMesh.renderOrder = -12;
      this.folioPaperMesh.userData.binderRole = "folio_spread_paper";
      this.innerGroup.add(this.folioPaperMesh);
    }

    this.marginHitGroup.name = "binder_margin_hits";
    this.innerGroup.add(this.marginHitGroup);

    this.coverHinge.name = "binder_front_cover_hinge";
    this.G.add(this.coverHinge);
    this._addFrontCover(this.coverHinge, this._sharedLeatherTex);

    this.pg = new THREE.PlaneGeometry(colW, rowH);
    this.paperStackGeo = new THREE.PlaneGeometry(BINDER_CFG.pageWidth * 0.98, BINDER_CFG.pageHeight * 0.97);
    this.etex = makeEmptyTexture();
    this.cardBackTex = createBinderCardBackTexture();
    this.ctex = this._withTestPagePadding(textures);
    this.chunks = this._mkChunks();

    this._v();
    this._tick = this._tick.bind(this);
    requestAnimationFrame(this._tick);
  }

  private _withTestPagePadding(incoming: THREE.Texture[]): THREE.Texture[] {
    const out = [...incoming];
    const targetPanels = BINDER_CODEX_SPREAD_COUNT * BINDER_CELLS_PER_PAGE;
    while (out.length < targetPanels) out.push(this.etex);
    const extra = BINDER_TEST_EXTRA_PAGES * BINDER_CELLS_PER_PAGE;
    for (let i = 0; i < extra; i++) out.push(this.etex);
    return out;
  }

  private _emptyChunk(): number[] {
    return Array.from({ length: BINDER_CELLS_PER_PAGE }, () => -1);
  }

  private _chunkHasCards(idx: readonly number[]): boolean {
    return idx.some((ix) => ix >= 0);
  }

  private _mkChunks(): number[][] {
    const n = this.ctex.length;
    const cell = BINDER_CELLS_PER_PAGE;
    const out: number[][] = [];
    for (let i = 0; i < n; i += cell) {
      out.push(Array.from({ length: cell }, (_, k) => (i + k < n ? i + k : -1)));
    }
    while (out.length > 0 && !this._chunkHasCards(out[out.length - 1]!)) {
      out.pop();
    }
    if (out.length === 0) {
      out.push(this._emptyChunk());
    }
    return out;
  }

  /** Right half-page verso: next chunk’s recto (duplex); missing next page → empty cells. */
  private _pairedVersoRight(chunkIdx: number): number[] {
    if (chunkIdx >= this.chunks.length - 1) return this._emptyChunk();
    return [...this.chunks[chunkIdx + 1]!];
  }

  /** Left spread: recto `chunks[s-1]`, verso same-spread right `chunks[s]`. */
  private _leftSpread(chunkIdx: number): { toward: number[]; paired: number[] } | null {
    if (chunkIdx <= 0) return null;
    const toward = this.chunks[chunkIdx - 1]!;
    /** Always return when `chunkIdx > 0`: an all-empty prior chunk still needs a left leaf (empty sleeves), otherwise `_v` skips `lp` and the folio shows a black void. */
    return { toward, paired: [...this.chunks[chunkIdx]!] };
  }

  /** Catalog / sleeve quads — unlit; `toneMapped:false` keeps CanvasTexture art readable under ACES on the renderer. */
  private _matPanel(map: THREE.Texture, opts?: { flipU?: boolean; flipV?: boolean }): THREE.MeshBasicMaterial {
    let tex: THREE.Texture = map;
    if (opts?.flipU || opts?.flipV) {
      tex = map.clone();
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.repeat.set(opts.flipU ? -1 : 1, opts.flipV ? -1 : 1);
      tex.offset.set(opts.flipU ? 1 : 0, opts.flipV ? 1 : 0);
      tex.needsUpdate = true;
    }
    return new THREE.MeshBasicMaterial({
      map: tex,
      side: THREE.DoubleSide,
      toneMapped: false,
      transparent: false,
      opacity: 1,
      depthWrite: true,
      depthTest: true,
      polygonOffset: false,
    });
  }

  /** Rear board + spine — the “outer” tome you feel behind the folio. */
  private _addTomeBackPlate(parent: THREE.Group, leatherMap: THREE.CanvasTexture): void {
    const PH = BINDER_CFG.pageHeight;
    const PW = BINDER_CFG.pageWidth;
    const leather = new THREE.MeshStandardMaterial({
      map: leatherMap,
      roughness: 0.9,
      metalness: 0.04,
      emissive: new THREE.Color(0x1a1008),
      emissiveIntensity: 0.12,
    });
    this._shellMaterials.push(leather);

    const spreadW = PW * 2 + 0.44;
    const spreadH = PH + 0.34;
    const backDepth = 0.12;
    const back = new THREE.Mesh(new THREE.BoxGeometry(spreadW, spreadH, backDepth), leather);
    back.position.set(0, 0, -0.132);
    parent.add(back);

    /** Center gutter / binding — reads as the spine between left and right pages when open. */
    const spine = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, spreadH + 0.04, backDepth + 0.08),
      leather,
    );
    spine.position.set(0, 0, -0.075);
    parent.add(spine);

    const paper = new THREE.MeshStandardMaterial({ color: 0xeae4d8, roughness: 0.94, metalness: 0 });
    this._shellMaterials.push(paper);
    const pageBlock = new THREE.Mesh(new THREE.BoxGeometry(0.05, spreadH * 0.9, 0.032), paper);
    pageBlock.position.set(0, 0, -0.055);
    parent.add(pageBlock);

    const ribM = new THREE.MeshStandardMaterial({
      color: 0x5c1828,
      roughness: 0.48,
      metalness: 0.12,
      emissive: new THREE.Color(0x180408),
      emissiveIntensity: 0.2,
    });
    this._shellMaterials.push(ribM);
    const ribbon = new THREE.Mesh(new THREE.BoxGeometry(0.038, PH * 0.5, 0.016), ribM);
    ribbon.position.set(0, PH * 0.04, -0.055);
    ribbon.rotation.set(0, 0, 0);
    ribbon.renderOrder = -2;
    parent.add(ribbon);
  }

  /** Inner deck + three-ring hardware (classic D-ring binder). */
  private _addRingBinderMechanism(
    shell: THREE.Group,
    ringRoot: THREE.Group,
    leatherMap: THREE.CanvasTexture,
  ): void {
    const PH = BINDER_CFG.pageHeight;
    const PW = BINDER_CFG.pageWidth;

    const deckMat = new THREE.MeshStandardMaterial({
      map: leatherMap,
      color: 0x3a2418,
      roughness: 0.86,
      metalness: 0.05,
      emissive: new THREE.Color(0x1c1008),
      emissiveIntensity: 0.1,
    });
    this._shellMaterials.push(deckMat);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(PW * 2 + 0.3, PH + 0.2, 0.052), deckMat);
    deck.position.set(0, 0, -0.038);
    shell.add(deck);

    const gold = new THREE.MeshStandardMaterial({
      color: 0xd7b068,
      roughness: 0.32,
      metalness: 0.9,
      emissive: new THREE.Color(0x1a1008),
      emissiveIntensity: 0.12,
    });
    this._shellMaterials.push(gold);
    for (const sx of [-1, 1] as const) {
      for (const sy of [-1, 1] as const) {
        const riv = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.022), gold);
        riv.position.set(sx * (PW + 0.05), sy * (PH / 2 + 0.06), -0.028);
        shell.add(riv);
      }
    }

    const metal = new THREE.MeshStandardMaterial({
      color: 0xc8ccd4,
      roughness: 0.22,
      metalness: 0.93,
      emissive: new THREE.Color(0x0a0c10),
      emissiveIntensity: 0.04,
    });
    this._shellMaterials.push(metal);

    /** Rings sit on the spine (x≈0) but **behind** card quads — card mats use depthWrite so metal cannot paint over the folio. */
    const gutterX = 0;
    ringRoot.position.set(0, 0, -0.048);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.09, PH * 0.9, 0.038), metal);
    rail.position.set(gutterX, 0, 0.004);
    ringRoot.add(rail);

    const postX = gutterX;
    const ringZ = -0.006;
    const ringYs = [-PH * 0.34, 0, PH * 0.34];
    for (const y of ringYs) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.072, 0.014, 16, 40), metal);
      ring.position.set(postX + 0.02, y, ringZ);
      ring.rotation.y = Math.PI / 2;
      ringRoot.add(ring);

      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.09, 12), metal);
      post.position.set(postX - 0.02, y, -0.018);
      post.rotation.z = Math.PI / 2;
      ringRoot.add(post);

      const clasp = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.034, 0.016), metal);
      clasp.position.set(postX + 0.055, y, ringZ);
      ringRoot.add(clasp);
    }
  }

  /** Hinged “ancient tome” front board + invisible pick face (Phase B). */
  private _addFrontCover(hinge: THREE.Group, leatherMap: THREE.CanvasTexture): void {
    const PH = BINDER_CFG.pageHeight;
    const PW = BINDER_CFG.pageWidth;
    const thick = 0.11;
    const spanZ = PW * 2 + 0.46;
    const hingeX = PW + 0.22;
    hinge.position.set(-hingeX, 0, 0.04);

    const boardMat = new THREE.MeshStandardMaterial({
      map: leatherMap,
      roughness: 0.82,
      metalness: 0.06,
    });
    this._coverBoardMat = boardMat;

    const board = new THREE.Mesh(new THREE.BoxGeometry(thick, PH + 0.28, spanZ), boardMat);
    board.position.set(thick / 2 + 0.02, 0, 0);
    board.renderOrder = 2;
    hinge.add(board);
    this.coverBoard = board;

    const cornerM = new THREE.MeshStandardMaterial({
      color: 0xcaa06a,
      roughness: 0.35,
      metalness: 0.88,
      emissive: new THREE.Color(0x1a1008),
      emissiveIntensity: 0.12,
    });
    this._coverMetalMaterials.push(cornerM);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const cg = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.04), cornerM);
        cg.position.set(thick / 2 + 0.02, sx * (PH / 2 + 0.08), sz * (spanZ / 2 - 0.06));
        hinge.add(cg);
      }
    }

    const hitMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const hit = new THREE.Mesh(new THREE.PlaneGeometry(spanZ * 0.96, PH * 0.94), hitMat);
    hit.position.set(thick + 0.07, 0, 0);
    hit.rotation.y = Math.PI / 2;
    hit.userData.binderRole = "front_cover";
    hinge.add(hit);
    this.coverHit = hit;

    this._coverDecoTex = createGrimoireCoverTexture();
    this._coverDecoMat = new THREE.MeshStandardMaterial({
      map: this._coverDecoTex,
      roughness: 0.38,
      metalness: 0.42,
      emissive: new THREE.Color(0x1a0f06),
      emissiveIntensity: 0.09,
    });
    const deco = new THREE.Mesh(
      new THREE.PlaneGeometry(spanZ * 0.9, (PH + 0.28) * 0.86),
      this._coverDecoMat,
    );
    deco.position.set(thick + 0.02 + 0.0035, 0, 0);
    deco.rotation.y = Math.PI / 2;
    deco.renderOrder = 4;
    hinge.add(deco);
  }

  private _gT(i: number): THREE.Texture {
    return i >= 0 && i < this.ctex.length ? this.ctex[i]! : this.etex;
  }

  private _rY(r: number): number {
    return (1 - r) * (rowH + BINDER_CFG.seamGap);
  }

  private _cX(c: number): number {
    return c * (colW + BINDER_CFG.seamGap) + colW / 2;
  }

  private static _cellIndex(row: number, col: number): number {
    return row * BINDER_COLS + col;
  }

  private _cellLocalX(col: number, side: 1 | -1): number {
    return side > 0 ? this._cX(col) : -(BINDER_CFG.pageWidth - this._cX(col));
  }

  /** Opaque folio paper behind the 3×3 slot grid so margins / grazing angles never read as the scene clear color. */
  private _makeHalfPagePaperBacking(side: 1 | -1): THREE.Mesh {
    const PW = BINDER_CFG.pageWidth;
    const PH = BINDER_CFG.pageHeight;
    const geo = new THREE.PlaneGeometry(PW * 0.996, PH * 0.996);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xe9e3da,
      transparent: false,
      toneMapped: false,
      depthWrite: true,
      depthTest: true,
    });
    const m = new THREE.Mesh(geo, mat);
    m.position.set(side * (PW / 2), 0, -0.0075);
    m.renderOrder = -5;
    m.userData.binderRole = "page_paper_backing";
    m.userData.ownsGeometry = true;
    return m;
  }

  /**
   * One half-page (9 cells): **same** code path for static spread and flip leaf (`kind` only changes render order).
   */
  private _pageSheet(
    toward: number[],
    paired: number[],
    side: 1 | -1,
    kind: "static" | "flip",
    meshRenderOrder: number,
  ): THREE.Group {
    const g = new THREE.Group();
    g.add(this._makeHalfPagePaperBacking(side));
    for (let r = 0; r < BINDER_ROWS; r++) {
      for (let c = 0; c < BINDER_COLS; c++) {
        const k = CardBinderEngine._cellIndex(r, c);
        const ti = toward[k]!;
        const pi = paired[k]!;
        const frontT = this._gT(ti);
        const backT = pi >= 0 ? this._gT(pi) : this.cardBackTex;
        const cell = this._binderCellPair(
          frontT,
          backT,
          ti,
          kind,
          meshRenderOrder,
          pi >= 0 ? pi : undefined,
          k,
          side,
        );
        cell.position.set(this._cellLocalX(c, side), this._rY(r), 0);
        cell.userData.gridRow = r;
        cell.userData.gridCol = c;
        cell.userData.cellIndex = k;
        g.add(cell);
      }
    }
    return g;
  }

  private _sp(toward: number[], paired: number[], side: number, meshRenderOrder = 3): THREE.Group {
    const s = side > 0 ? 1 : -1;
    return this._pageSheet(toward, paired, s, "static", meshRenderOrder);
  }

  /**
   * One catalog duplex: recto + verso are two parallel card quads (magnet front/back), sharing the cell’s XY plane.
   * `_kind` only affects render order for the turning leaf vs static spreads.
   */
  private _binderCellPair(
    frontTex: THREE.Texture,
    backTex: THREE.Texture,
    rectoPickIndex: number,
    kind: "static" | "flip",
    _meshRenderOrder: number,
    versoPickIndex: number | undefined,
    slotDepthIndex: number,
    halfPageSide: 1 | -1,
  ): THREE.Group {
    const cell = new THREE.Group();
    const half = MAGNET_FACE_GAP * 0.5;
    const zBias = slotDepthIndex * MAGNET_SLOT_Z_STAGGER;

    const front = new THREE.Mesh(this.pg, this._matPanel(frontTex));
    front.position.z = half + zBias;
    front.renderOrder = kind === "flip" ? 160 : 110;
    front.userData.pickIndex = rectoPickIndex;
    front.userData.gridPick = rectoPickIndex >= 0;
    front.userData.binderFace = "recto" as const;
    front.userData.binderRole = "slot_recto" as const;
    if (rectoPickIndex >= 0) front.userData.catalogIndex = rectoPickIndex;

    // Left half-page sits in -X; mirror verso U so backs read correctly vs right half.
    const back = new THREE.Mesh(
      this.pg,
      this._matPanel(backTex, { flipV: true, flipU: halfPageSide < 0 }),
    );
    back.position.z = -half - zBias;
    back.rotation.x = Math.PI;
    back.renderOrder = kind === "flip" ? 158 : 108;
    back.userData.binderFace = "verso" as const;
    back.userData.binderRole = "slot_verso" as const;
    if (versoPickIndex !== undefined && versoPickIndex >= 0) {
      back.userData.pickIndex = versoPickIndex;
      back.userData.catalogIndex = versoPickIndex;
    }

    cell.add(front);
    cell.add(back);
    return cell;
  }

  private _addPaperStackUnder(page: THREE.Group, xCenter: number): void {
    for (let i = 0; i < 4; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xe6e0d6,
        transparent: true,
        opacity: 0.042 + i * 0.014,
        depthWrite: false,
      });
      const m = new THREE.Mesh(this.paperStackGeo, mat);
      m.position.set(xCenter, 0, PAGE_SURFACE_Z - 0.0024 - i * 0.00105);
      m.renderOrder = -6 - i;
      m.userData.binderRole = "paper_stack";
      page.add(m);
    }
  }

  private _cl(p: THREE.Group | null): void {
    if (!p) return;
    p.removeFromParent();
    p.traverse((ch) => {
      const o = ch as THREE.Mesh;
      if (o.isMesh && o.userData._outline) this._stripPanelOutline(o);
      if (o.isMesh && o.material && !o.userData.skipMaterialDispose) {
        (o.material as THREE.Material).dispose();
      }
      if (o.isMesh && o.userData.ownsGeometry === true && o.geometry) {
        o.geometry.dispose();
      }
    });
  }

  private _v(): void {
    this._cl(this.lp);
    this._cl(this.rp);
    this._cl(this.fp);
    this.lp = this.rp = this.fp = null;
    const s = this.cur;
    const left = this._leftSpread(s);
    if (left) {
      this.lp = this._sp(left.toward, left.paired, -1);
      this.lp.position.z = PAGE_SURFACE_Z;
      this._addPaperStackUnder(this.lp, -BINDER_CFG.pageWidth / 2);
      this.innerGroup.add(this.lp);
    } else if (s === 0) {
      /** First spread: `_leftSpread(0)` is null — still draw the left leaf so both halves read as a folio. */
      this.lp = this._sp(this._emptyChunk(), this._emptyChunk(), -1);
      this.lp.position.z = PAGE_SURFACE_Z;
      this._addPaperStackUnder(this.lp, -BINDER_CFG.pageWidth / 2);
      this.innerGroup.add(this.lp);
    }
    if (this.chunks[s]) {
      this.rp = this._sp(this.chunks[s]!, this._pairedVersoRight(s), 1);
      this.rp.position.z = PAGE_SURFACE_Z;
      this._addPaperStackUnder(this.rp, BINDER_CFG.pageWidth / 2);
      this.innerGroup.add(this.rp);
    }
    this._notifyPage();
    this._applyPanelHighlights();
    this._syncMarginHits();
  }

  private _sf(): void {
    this._cl(this.fp);
    this.fp = null;
    const s = this.cur;
    if (this.fl === 1 && this.chunks[s]) {
      const dest = s + 1;
      /** Destination left page under the turn — matches post-flip `_v` so cards don’t “swap” mid-animation. */
      this._cl(this.lp);
      this.lp = null;
      const ld = this._leftSpread(dest);
      if (ld) {
        this.lp = this._sp(ld.toward, ld.paired, -1, 1);
        this.lp.position.z = PAGE_SURFACE_Z - UNDER_PAGE_Z_LIFT;
        this.innerGroup.add(this.lp);
      }
      this.fp = this._pageSheet(this.chunks[s]!, this._pairedVersoRight(s), 1, "flip", 5);
      this.fp.position.set(FLIP_LEAF_HINGE_X, 0, PAGE_SURFACE_Z + FLIP_LEAF_Z_EPS);
      this.innerGroup.add(this.fp);
      this._cl(this.rp);
      this.rp = null;
      if (this.chunks[s + 1]) {
        const nx = s + 1;
        this.rp = this._sp(this.chunks[nx]!, this._pairedVersoRight(nx), 1, 1);
        this.rp.position.z = PAGE_SURFACE_Z - UNDER_PAGE_Z_LIFT;
        this.innerGroup.add(this.rp);
      }
      this._applyPanelHighlights();
    }
    if (this.fl === -1 && this.chunks[s - 1]) {
      const dest = s - 1;
      this.fp = this._pageSheet(this.chunks[s - 1]!, this.chunks[s]!, -1, "flip", 5);
      this.fp.position.set(FLIP_LEAF_HINGE_X, 0, PAGE_SURFACE_Z + FLIP_LEAF_Z_EPS);
      this.innerGroup.add(this.fp);
      /** Static right page must be the **destination** spread, not the old one (was causing wrong cards mid-flip). */
      this._cl(this.rp);
      this.rp = null;
      this.rp = this._sp(this.chunks[dest]!, this._pairedVersoRight(dest), 1, 1);
      this.rp.position.z = PAGE_SURFACE_Z - UNDER_PAGE_Z_LIFT;
      this.innerGroup.add(this.rp);
      this._cl(this.lp);
      this.lp = null;
      const ll = this._leftSpread(dest);
      if (ll) {
        this.lp = this._sp(ll.toward, ll.paired, -1, 1);
        this.lp.position.z = PAGE_SURFACE_Z - UNDER_PAGE_Z_LIFT;
        this.innerGroup.add(this.lp);
      } else if (dest === 0) {
        /** Match `_v` for spread 0 — otherwise the left folio is missing for the whole peel and cards read “wrong”. */
        this.lp = this._sp(this._emptyChunk(), this._emptyChunk(), -1, 1);
        this.lp.position.z = PAGE_SURFACE_Z - UNDER_PAGE_Z_LIFT;
        this.innerGroup.add(this.lp);
      }
      this._applyPanelHighlights();
    }
    this._syncMarginHits();
  }

  private _aa(a: number): void {
    if (!this.fp) return;
    this.fp.rotation.y = this.fl === 1 ? -a : a;
    const sn = Math.sin(a);
    const lift = sn * (1.0 - Math.cos(a)) * 0.5;
    this.fp.position.x = FLIP_LEAF_HINGE_X;
    this.fp.position.z = PAGE_SURFACE_Z + FLIP_LEAF_Z_EPS + 0.032 * lift;
  }

  private _done(): void {
    if (this.fl === 1) this.cur++;
    else if (this.fl === -1) this.cur--;
    this.fl = 0;
    this.ang = 0;
    this.vel = 0;
    this.tgt = null;
    this.pageAudio.thud();
    this.pageAudio.frictionStop();
    this._v();
  }

  private _canc(): void {
    this.fl = 0;
    this.ang = 0;
    this.vel = 0;
    this.tgt = null;
    this.pageAudio.rustle();
    this.pageAudio.frictionStop();
    this._v();
  }

  private _notifyPage(): void {
    this.onPageChange?.(this.cur, Math.max(1, this.chunks.length));
  }

  flipNext(): void {
    if (this.openingProgress < BINDER_FULLY_OPEN_PROGRESS || this.fl) return;
    if (this.chunks.length <= 1) return;
    this.cancelPendingCatalogPick();
    if (this.cur >= this.chunks.length - 1) {
      this.jumpToFirstSpread();
      return;
    }
    this.fl = 1;
    this.ang = 0;
    this.vel = 0;
    this.tgt = Math.PI;
    this._sf();
  }

  flipPrev(): void {
    if (this.openingProgress < BINDER_FULLY_OPEN_PROGRESS || this.fl) return;
    if (this.chunks.length <= 1) return;
    this.cancelPendingCatalogPick();
    /** Spread 0: no left leaf to peel — jump to end so “Prev” still moves backward through the codex. */
    if (this.cur <= 0) {
      this.jumpToLastSpread();
      return;
    }
    this.fl = -1;
    this.ang = 0;
    this.vel = 0;
    this.tgt = Math.PI;
    this._sf();
  }

  /** Jump without animation (only when idle). Does not replace drag-to-turn. */
  jumpToFirstSpread(): void {
    if (this.openingProgress < BINDER_FULLY_OPEN_PROGRESS || this.fl !== 0) return;
    if (this.cur === 0) return;
    this.cancelPendingCatalogPick();
    this.cur = 0;
    this._v();
  }

  /** Jump without animation (only when idle). */
  jumpToLastSpread(): void {
    if (this.openingProgress < BINDER_FULLY_OPEN_PROGRESS || this.fl !== 0) return;
    const last = Math.max(0, this.chunks.length - 1);
    if (this.cur === last) return;
    this.cancelPendingCatalogPick();
    this.cur = last;
    this._v();
  }

  setTextures(incoming: THREE.Texture[]): void {
    this.cancelPendingCatalogPick();
    this.ctex = this._withTestPagePadding(incoming);
    this.chunks = this._mkChunks();
    this.cur = Math.min(this.cur, Math.max(0, this.chunks.length - 1));
    this.fl = 0;
    this.ang = 0;
    this.vel = 0;
    this.tgt = null;
    this._v();
  }

  resize(w: number, h: number): void {
    this.R.setSize(w, h, false);
    this.cam.aspect = w / h;
    this.cam.updateProjectionMatrix();
  }

  resetCam(): void {
    this.yaw = 0;
    const open = this.openingProgress >= BINDER_FULLY_OPEN_PROGRESS;
    this.pitch = open ? -0.14 : -0.27;
    this.dist = open ? 5.88 : 4.92;
    this.pitch = THREE.MathUtils.clamp(this.pitch, BINDER_ORBIT_PITCH_MIN, BINDER_ORBIT_PITCH_MAX);
  }

  /**
   * OS overlays (screenshots), tab blur, or lost capture can skip `pointerup` — finish an active page drag
   * so the spring (`tgt`) runs and the leaf does not freeze mid-turn.
   */
  releaseInterruptedGesture(): void {
    this.orb = false;
    this.coverTapArmed = false;
    this.pendingCardTap = false;
    this.flipArm = null;
    if (this.drag) this._settleActivePageDrag();
  }

  private _settleActivePageDrag(): void {
    if (!this.drag) return;
    this.drag = false;
    this.pageAudio.frictionStop();
    const pv = Math.abs(this.pointerVxNorm);
    this.pointerVxNorm = 0;
    this.flipArm = null;
    if (this.fl === 0) {
      this.tgt = null;
      return;
    }
    const thr = Math.PI * (0.4 - Math.min(0.17, pv));
    this.tgt = this.ang >= thr ? Math.PI : 0;
  }

  syncDoctrineHighlights(
    orderedCatalogIds: readonly string[],
    slots: readonly (string | null)[],
    activeSlot: number | null,
  ): void {
    this.doctrOrder = [...orderedCatalogIds];
    this.doctrSlots = slots.length ? [...slots] : Array.from({ length: DOCTRINE_SLOT_COUNT }, () => null);
    while (this.doctrSlots.length < DOCTRINE_SLOT_COUNT) this.doctrSlots.push(null);
    if (this.doctrSlots.length > DOCTRINE_SLOT_COUNT) this.doctrSlots.length = DOCTRINE_SLOT_COUNT;
    this.doctrActive = activeSlot;
    this._applyPanelHighlights();
  }

  private _stripPanelOutline(mesh: THREE.Mesh): void {
    const ex = mesh.userData._outline as THREE.LineLoop | undefined;
    if (ex) {
      mesh.remove(ex);
      ex.geometry.dispose();
      (ex.material as THREE.Material).dispose();
      delete mesh.userData._outline;
    }
  }

  private _applyPanelHighlights(): void {
    const order = this.doctrOrder;
    const slots = this.doctrSlots;
    const active = this.doctrActive;
    const activeId = active !== null && active >= 0 && active < slots.length ? slots[active] : null;
    const chosen = new Set(slots.filter((x): x is string => Boolean(x)));
    const hw = colW * 0.5 - 0.02;
    const hh = rowH * 0.5 - 0.02;
    const rectPts = [
      new THREE.Vector3(-hw, -hh, 0),
      new THREE.Vector3(hw, -hh, 0),
      new THREE.Vector3(hw, hh, 0),
      new THREE.Vector3(-hw, hh, 0),
    ];

    this.G.traverse((ch) => {
      const mesh = ch as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh.userData.gridPick !== true) return;
      const pi = mesh.userData.pickIndex;
      if (typeof pi !== "number" || pi < 0) return;
      const cid = order[pi];
      if (!cid) {
        this._stripPanelOutline(mesh);
        return;
      }
      this._stripPanelOutline(mesh);
      if (!chosen.has(cid)) return;

      const primary = activeId !== null && cid === activeId;
      const g = new THREE.BufferGeometry().setFromPoints(rectPts);
      const mat = new THREE.LineBasicMaterial({
        color: primary ? 0x5cff9a : 0x2ab86a,
        transparent: true,
        opacity: primary ? 1 : 0.88,
        depthTest: true,
        depthWrite: false,
      });
      const lines = new THREE.LineLoop(g, mat);
      lines.position.z = 0.008;
      lines.renderOrder = 130;
      mesh.add(lines);
      mesh.userData._outline = lines;
    });
  }

  wheel(dy: number): void {
    this.dist = Math.max(3, Math.min(12, this.dist + dy * 0.005));
  }

  getBinderUiMode(): BinderUiMode {
    return deriveBinderUiMode({
      openingProgress: this.openingProgress,
      orb: this.orb,
      fl: this.fl,
      drag: this.drag,
      tgt: this.tgt,
    });
  }

  /** Cancel delayed catalog pick (e.g. before double-click detail). */
  cancelPendingCatalogPick(): void {
    if (this._pickDebounceHandle !== null) {
      globalThis.clearTimeout(this._pickDebounceHandle);
      this._pickDebounceHandle = null;
    }
  }

  private _pickablePageMeshes(): THREE.Mesh[] {
    const roots = [this.lp, this.rp, this.fp].filter((g): g is THREE.Group => g !== null);
    const out: THREE.Mesh[] = [];
    for (const root of roots) {
      root.traverse((ch) => {
        const m = ch as THREE.Mesh;
        if (!m.isMesh) return;
        if (typeof m.userData.pickIndex !== "number") return;
        if (m.userData.binderRole === "page_margin") return;
        out.push(m);
      });
    }
    return out;
  }

  /**
   * Previously spawned large “invisible” gutter meshes for ray hits; some GPUs still drew them as a black slab.
   * Page-turn arming uses `_edgeTurnSideFromPlane` + `hitSpreadSide` fallback (see `pD`) — no margin quads needed.
   */
  private _syncMarginHits(): void {
    for (const ch of [...this.marginHitGroup.children]) {
      const m = ch as THREE.Mesh;
      this.marginHitGroup.remove(m);
      m.geometry.dispose();
    }
    if (this._marginMat) {
      this._marginMat.dispose();
      this._marginMat = null;
    }
  }

  private _applyBinderOpenness(): void {
    const te = easeOutCubic(this.openingProgress);
    this.coverHinge.rotation.y = te * (-1.24 * Math.PI);
    this.innerGroup.visible = this.openingProgress > 0.09;
    this.coverHinge.visible = this.openingProgress < 0.992;
    const mechTe = THREE.MathUtils.smoothstep(this.openingProgress, 0.04, 0.24);
    if (this.openingProgress < 0.035) {
      this._metalTickDoneForOpen = false;
      this._lastMechTe = 0;
    }
    if (!this._metalTickDoneForOpen && this._lastMechTe < 0.17 && mechTe >= 0.17) {
      this.pageAudio.metalTick();
      this._metalTickDoneForOpen = true;
    }
    this._lastMechTe = mechTe;
    this.shellGroup.visible = this.openingProgress > 0.035;
    this.shellGroup.position.z = THREE.MathUtils.lerp(-0.036, 0.014, te);
    this.ringMechanismGroup.scale.setScalar(0.78 + 0.22 * mechTe);
    this.tomeBackGroup.position.z = THREE.MathUtils.lerp(0, 0.012, te);
    const open = this.openingProgress >= BINDER_FULLY_OPEN_PROGRESS;
    if (open !== this._lastNotifiedOpen) {
      this._lastNotifiedOpen = open;
      if (open) {
        this._syncMarginHits();
        /** Rebuild spreads once the folio is actually open — avoids the first `_v()` while `openingProgress===0` (logged in NDJSON) and keeps slots aligned with visibility gates. */
        if (!this.disposed) this._v();
      }
      this.onOpenStateChange?.(open);
    }
  }

  private _rayHitsCover(clientX: number, clientY: number, rect: DOMRect): boolean {
    if (!this.coverHit || !this.coverHinge.visible) return false;
    this.ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.ndc, this.cam);
    return this.raycaster.intersectObject(this.coverHit, false).length > 0;
  }

  private hitSpreadSide(clientX: number, clientY: number, rect: DOMRect): "left" | "right" | null {
    if (!interactionMayArmPageTurn(this.getBinderUiMode())) return null;
    this.ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.ndc, this.cam);
    const objs = this.marginHitGroup.children as THREE.Mesh[];
    if (objs.length === 0) return null;
    const hits = this.raycaster.intersectObjects(objs, false);
    if (hits.length === 0) return null;
    const side = hits[0]!.object.userData.marginSide as "left" | "right" | undefined;
    if (side === "right" && this.chunks.length > 1) return "right";
    if (side === "left" && this.chunks.length > 1) return "left";
    return null;
  }

  /**
   * Outer horizontal bands on the folio plane — arms page turns before card picks (doctrine UX).
   * Uses the folio plane z, not margin quads (those sit in front of card slots in ray order).
   */
  private _edgeTurnSideFromPlane(clientX: number, clientY: number, rect: DOMRect): "left" | "right" | null {
    if (!interactionMayArmPageTurn(this.getBinderUiMode())) return null;
    const PW = BINDER_CFG.pageWidth;
    const PH = BINDER_CFG.pageHeight;
    const edge = PW * 0.74;
    this.ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.ndc, this.cam);
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -PAGE_SURFACE_Z);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, hit)) return null;
    if (Math.abs(hit.y) > PH * 0.58) return null;
    if (hit.x >= edge && this.chunks.length > 1) return "right";
    if (hit.x <= -edge && this.chunks.length > 1) return "left";
    return null;
  }

  /** Kept for canvas `pointerleave` — slots stay flat (no hover depth motion). */
  clearCardHover(): void {}

  pD(e: PointerEvent, rect: DOMRect): void {
    this.pageAudio.resumeFromGesture();
    this.cancelPendingCatalogPick();
    this.pendingCardTap = false;

    if (e.button === 2 || e.shiftKey) {
      this.orb = true;
      this.oSX = e.clientX;
      this.oSY = e.clientY;
      this.oSY2 = this.yaw;
      this.oSP = this.pitch;
      return;
    }

    const mode = this.getBinderUiMode();
    if (mode === "closed" || mode === "opening") {
      this.flipArm = null;
      this.coverTapArmed = mode === "closed" && this._rayHitsCover(e.clientX, e.clientY, rect);
      this.armSX = e.clientX;
      this.armSY = e.clientY;
      this.drag = false;
      this.dSX = e.clientX;
      this.dSA = 0;
      return;
    }

    this.flipArm = null;
    this.coverTapArmed = false;

    if (interactionMayArmPageTurn(mode) && !this.fl) {
      const side =
        this.hitSpreadSide(e.clientX, e.clientY, rect) ??
        this._edgeTurnSideFromPlane(e.clientX, e.clientY, rect);
      if (side === "right" && this.cur < this.chunks.length - 1) this.flipArm = "next";
      else if (side === "left" && this.cur > 0) this.flipArm = "prev";
    }

    if (!this.flipArm && interactionMayPickCatalog(mode)) {
      const idx = this.pickAt(e.clientX, e.clientY, rect);
      if (idx !== null && idx >= 0) this.pendingCardTap = true;
    }

    this.armSX = e.clientX;
    this.armSY = e.clientY;
    this.drag = false;
    this.dSX = e.clientX;
    this.dSA = 0;
  }

  pM(e: PointerEvent, rect: DOMRect): void {
    if (this.orb) {
      const dx = (e.clientX - this.oSX) / rect.width;
      const dy = (e.clientY - this.oSY) / rect.height;
      this.yaw = THREE.MathUtils.clamp(this.oSY2 + dx * Math.PI, -BINDER_ORBIT_YAW_LIMIT, BINDER_ORBIT_YAW_LIMIT);
      this.pitch = THREE.MathUtils.clamp(
        this.oSP + dy * Math.PI * 0.6,
        BINDER_ORBIT_PITCH_MIN,
        BINDER_ORBIT_PITCH_MAX,
      );
      return;
    }

    const dx = e.clientX - this.armSX;
    const dy = e.clientY - this.armSY;
    const dist = Math.hypot(dx, dy);

    if (this.pendingCardTap && dist >= this.FLIP_ARM_PX) {
      this.pendingCardTap = false;
    }

    if (!this.drag && this.flipArm && dist >= this.FLIP_ARM_PX) {
      if (this.flipArm === "next") {
        this.fl = 1;
        this.ang = 0;
        this.vel = 0;
        this.tgt = null;
        this._sf();
      } else {
        this.fl = -1;
        this.ang = 0;
        this.vel = 0;
        this.tgt = null;
        this._sf();
      }
      this.drag = true;
      this.dSX = e.clientX;
      this.dSA = this.ang;
      this.flipArm = null;
      this.pageAudio.resumeFromGesture();
      this.pageAudio.frictionStart();
      this.lastMoveClientX = e.clientX;
      this.lastMoveT = performance.now();
      this.pointerVxNorm = 0;
    }

    if (!this.drag) {
      return;
    }

    const now = performance.now();
    const dtMs = now - this.lastMoveT;
    if (dtMs > 0 && dtMs < 90) {
      const vx = (e.clientX - this.lastMoveClientX) / dtMs;
      this.pointerVxNorm = THREE.MathUtils.lerp(this.pointerVxNorm, vx * 10, 0.4);
    }
    this.lastMoveClientX = e.clientX;
    this.lastMoveT = now;
    const drag = ((e.clientX - this.dSX) / rect.width) * Math.PI * 1.5;
    // Next: drag from the right gutter toward the spine (mouse left) increases angle.
    // Prev: drag from the left gutter outward (mouse right) must increase angle — same `- drag` would clamp to 0.
    const raw = THREE.MathUtils.clamp(
      this.fl === 1 ? this.dSA - drag : this.dSA + drag,
      0,
      Math.PI,
    );
    this.ang = dragAngleShaped(raw);
  }

  pU(e: PointerEvent, rect: DOMRect): void {
    this.orb = false;

    const moved = Math.hypot(e.clientX - this.armSX, e.clientY - this.armSY);
    const mode = this.getBinderUiMode();

    if (!this.drag) {
      if (mode === "closed") {
        if (
          this.coverTapArmed &&
          moved <= this.TAP_MAX_PX &&
          this._rayHitsCover(e.clientX, e.clientY, rect)
        ) {
          this.openBinder();
        }
        this.coverTapArmed = false;
        this.pendingCardTap = false;
        this.flipArm = null;
        return;
      }
      if (mode === "opening") {
        this.coverTapArmed = false;
        this.pendingCardTap = false;
        this.flipArm = null;
        return;
      }
      if (
        this.pendingCardTap &&
        this.fl === 0 &&
        moved <= this.TAP_MAX_PX &&
        interactionMayPickCatalog(mode)
      ) {
        const idx = this.pickAt(e.clientX, e.clientY, rect);
        if (idx !== null && idx >= 0) {
          this._pickDebounceHandle = globalThis.setTimeout(() => {
            this._pickDebounceHandle = null;
            this.onPickCatalogIndex?.(idx);
          }, 260);
        }
      }
      this.pendingCardTap = false;
      this.flipArm = null;
      return;
    }

    this._settleActivePageDrag();
  }

  pickAt(clientX: number, clientY: number, rect: DOMRect): number | null {
    if (!interactionMayPickCatalog(this.getBinderUiMode())) return null;
    this.ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.ndc, this.cam);
    const objs = this._pickablePageMeshes();
    const hits = this.raycaster.intersectObjects(objs, false);
    hits.sort((a, b) => a.distance - b.distance);
    let bestRecto: number | null = null;
    for (const h of hits) {
      const m = h.object as THREE.Mesh;
      const pi = m.userData.pickIndex as number;
      if (typeof pi !== "number" || pi < 0) continue;
      if (m.userData.binderFace === "verso") {
        if (bestRecto === null) bestRecto = pi;
        continue;
      }
      if (m.userData.gridPick === true) return pi;
      if (bestRecto === null) bestRecto = pi;
    }
    return bestRecto;
  }

  private _tick(): void {
    if (this.disposed) return;
    const dt = Math.min(0.05, this.clock.getDelta());
    if (this.openingTarget !== null) {
      const k = 5.8;
      this.openingProgress += (this.openingTarget - this.openingProgress) * Math.min(1, k * dt);
      if (Math.abs(this.openingTarget - this.openingProgress) < 0.006) {
        this.openingProgress = this.openingTarget;
        this.openingTarget = null;
      }
    }
    this._applyBinderOpenness();
    if (this.fl && !this.drag && this.tgt !== null) {
      this.vel += (-BINDER_CFG.springStiff * (this.ang - this.tgt) - BINDER_CFG.springDamp * this.vel) * dt;
      this.ang += this.vel * dt;
      if (
        (this.fl === 1 && this.tgt === Math.PI && this.ang >= Math.PI - 0.01) ||
        (this.fl === -1 && this.tgt === Math.PI && this.ang >= Math.PI - 0.01)
      ) {
        if (Math.abs(this.vel) < 0.36) this._done();
      } else if (
        (this.fl === 1 && this.tgt === 0 && this.ang <= 0.01) ||
        (this.fl === -1 && this.tgt === 0 && this.ang <= 0.01)
      ) {
        if (Math.abs(this.vel) < 0.36) this._canc();
      }
    }
    if (this.fp) this._aa(this.ang);
    this.yaw = THREE.MathUtils.clamp(this.yaw, -BINDER_ORBIT_YAW_LIMIT, BINDER_ORBIT_YAW_LIMIT);
    this.pitch = THREE.MathUtils.clamp(this.pitch, BINDER_ORBIT_PITCH_MIN, BINDER_ORBIT_PITCH_MAX);
    const flipping = this.fl !== 0 && this.fp !== null;
    const tCam = easeOutCubic(this.openingProgress);
    let distBlend = THREE.MathUtils.lerp(4.88, this.dist, tCam);
    if (flipping) distBlend *= 1 + 0.016 * Math.sin(this.ang);
    const pitchBlend = THREE.MathUtils.lerp(-0.28, this.pitch, tCam);
    const yawNudge = THREE.MathUtils.lerp(0.09, 0, tCam);
    this.cam.position.set(
      distBlend * Math.cos(pitchBlend) * Math.sin(this.yaw + yawNudge),
      distBlend * Math.sin(pitchBlend) + 0.2,
      distBlend * Math.cos(pitchBlend) * Math.cos(this.yaw + yawNudge),
    );
    this.cam.lookAt(0, 0, 0);
    this.R.render(this.S, this.cam);
    if (!this.disposed) requestAnimationFrame(this._tick);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelPendingCatalogPick();
    for (const ch of [...this.marginHitGroup.children]) {
      const m = ch as THREE.Mesh;
      this.marginHitGroup.remove(m);
      m.geometry.dispose();
    }
    this._marginMat?.dispose();
    this._marginMat = null;
    for (const L of this._ownedLights) {
      this.S.remove(L);
      L.dispose();
    }
    this._ownedLights.length = 0;
    this.cardBackTex.dispose();
    this.etex.dispose();
    this._cl(this.lp);
    this._cl(this.rp);
    this._cl(this.fp);
    this.lp = this.rp = this.fp = null;
    this.tomeBackGroup.traverse((ch) => {
      const m = ch as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    this.shellGroup.traverse((ch) => {
      const m = ch as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    for (const mat of this._shellMaterials) {
      if (mat.map === this._sharedLeatherTex) mat.map = null;
      else mat.map?.dispose();
      mat.dispose();
    }
    this._shellMaterials.length = 0;
    this.G.remove(this.tomeBackGroup);
    this.G.remove(this.shellGroup);

    this.coverHinge.traverse((ch) => {
      const m = ch as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    for (const mat of this._coverMetalMaterials) mat.dispose();
    this._coverMetalMaterials.length = 0;
    if (this._coverBoardMat) {
      if (this._coverBoardMat.map === this._sharedLeatherTex) this._coverBoardMat.map = null;
      this._coverBoardMat.dispose();
      this._coverBoardMat = null;
    }
    if (this._coverDecoMat) {
      this._coverDecoMat.map = null;
      this._coverDecoMat.dispose();
      this._coverDecoMat = null;
    }
    this._coverDecoTex?.dispose();
    this._coverDecoTex = null;
    const hitM = this.coverHit?.material as THREE.MeshBasicMaterial | undefined;
    if (hitM) hitM.dispose();
    this.coverHit = null;
    if (this.coverBoard) {
      this.coverBoard.traverse((ch) => {
        const m = ch as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
    }
    this.coverBoard = null;
    this.G.remove(this.coverHinge);

    this.innerGroup.remove(this.folioPaperMesh);
    this.folioPaperMesh.geometry.dispose();
    (this.folioPaperMesh.material as THREE.Material).dispose();
    this.pageAudio.dispose();
    this.G.remove(this.innerGroup);
    this._sharedLeatherTex.dispose();
    this.paperStackGeo.dispose();
    this.pg.dispose();
    this.R.dispose();
  }

  isBinderOpen(): boolean {
    return this.openingProgress >= BINDER_FULLY_OPEN_PROGRESS;
  }

  openBinder(): void {
    if (this.openingProgress >= BINDER_FULLY_OPEN_PROGRESS) return;
    this.openingTarget = 1;
  }

  /** Skip the cover animation — codex starts fully open (doctrine picker UX). */
  snapBinderFullyOpen(): void {
    this.openingProgress = 1;
    this.openingTarget = null;
    this._lastNotifiedOpen = false;
    this._applyBinderOpenness();
    if (!this.disposed) {
      this.cam.updateProjectionMatrix();
      this.R.render(this.S, this.cam);
    }
  }

  get pageIndex(): number {
    return this.cur;
  }

  get pageCount(): number {
    return Math.max(1, this.chunks.length);
  }
}

export type { BinderUiMode } from "./binderInteractionState";
