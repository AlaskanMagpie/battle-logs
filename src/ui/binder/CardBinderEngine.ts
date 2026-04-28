import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { createSkyPanorama, type SkyPanoramaMesh } from "../../render/skyPanorama";
import { getControlProfile, type ControlProfile } from "../../controlProfile";
import { TCG_FULL_CARD_H, TCG_FULL_CARD_W } from "../tcgCardPrint";
import { createBinderCardBackTexture } from "./binderCardBackTexture";
import {
  BINDER_FULLY_OPEN_PROGRESS,
  deriveBinderUiMode,
  interactionMayArmPageTurn,
  interactionMayPickCatalog,
  mayRaycastCatalog,
  type BinderUiMode,
} from "./binderInteractionState";
import { composeCardIntoBinderSleeve } from "./binderSleeveComposite";
import { BinderPageAudio } from "./binderPageAudio";
import { createGrimoireCoverTexture, createTomeRearBoardFaceTexture, paintBinderLeatherGrain } from "./binderTomeArt";

/** Binder layout + flip physics (ported from CardBinder.jsx). */
export const BINDER_CFG = {
  pageWidth: 2.1,
  pageHeight: 2.85,
  seamGap: 0.04,
  seamFlex: 0.18,
  rowDroop: 0.06,
  /** Snappier settle + slightly less overshoot than legacy defaults. */
  springStiff: 108,
  springDamp: 15.6,
  panelTexW: 400,
  /** Scene clear — parchment (never “void black” at grazing angles). */
  bg: 0xebe4d8,
} as const;

/** 3×3 cells per face (nine sleeves on the side of a sheet facing you). */
export const BINDER_COLS = 3;
export const BINDER_ROWS = 3;
export const BINDER_CELLS_PER_PAGE = BINDER_COLS * BINDER_ROWS;
/** One turnable sheet: nine catalog panels on the front + nine on the back (same chunk indices 0–8 / 9–17). */
export const BINDER_CELLS_PER_SHEET = BINDER_CELLS_PER_PAGE * 2;

/**
 * @deprecated Unused — codex length is fixed by `BINDER_CODEX_SPREAD_COUNT`.
 */
export const BINDER_TEST_EXTRA_PAGES = 0;

/** Doctrine codex: always this many spreads (empty sleeves pad the catalog). */
export const BINDER_CODEX_SPREAD_COUNT = 10;

/** `BINDER_CODEX_SPREAD_COUNT` spreads × 18 duplex slots (3×3 recto + 3×3 verso per sheet). */
export const BINDER_CODEX_TOTAL_CELLS = BINDER_CODEX_SPREAD_COUNT * BINDER_CELLS_PER_SHEET;

export type CardBinderEngineOptions = {
  /** @deprecated Shell is always on (CardBinder.html); kept for API compatibility. */
  showLeatherBackdrop?: boolean;
  /**
   * Doctrine picker: quick tap selects a recto cell; tap empty folio clears selection.
   * Long-press on **any** face card lifts that card (sleeve shows card-back), then drag to the DOM hand.
   * Page peel: outer-margin intent wins over a card ray-hit so peels still arm.
   * RMB looks around the portal room within a small yaw/pitch range.
   */
  codexHandDragMode?: boolean;
  controlProfile?: ControlProfile;
};

export type CodexPointerDragEvent = {
  phase: "start" | "move" | "end" | "cancel";
  pickIndex: number;
  clientX: number;
  clientY: number;
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
/** Keep the turning leaf clearly in front of the under-stack while peeling (reduces transient sparkle). */
const FLIP_LEAF_Z_EPS = 0.017;
/** Push idle-under pages a bit farther back so they never share a depth plane with the folio / turning leaf. */
const UNDER_PAGE_Z_LIFT = 0.009;
/**
 * Duplex “magnet” slot: recto + verso are parallel planes with a tiny symmetric gap (no pocket, no per-recto lift).
 * Each page is a 3×3 grid of these slots; the turning leaf is the same rigid geometry, only the whole `fp` rotates.
 */
const MAGNET_FACE_GAP = 0.004;
/** Per-slot Z bias so nine nearly coplanar quads don’t shimmer at grazing angles (esp. later spreads / prev flip). */
const MAGNET_SLOT_Z_STAGGER = 0.00022;

/**
 * `innerGroup` draw order for stacked halves: under-pages first, idle rest pages, turning leaf last during a peel
 * (pairs with log depth so opaque layers don’t sparkle when depths are close).
 */
const PAGE_RENDER_UNDER = 0;
const PAGE_RENDER_REST = 4;
const PAGE_RENDER_TURNING = 28;

/**
 * Split spring integration so one display frame never jumps the peel by a large angle (fast flips + `FrontSide`
 * culling briefly showed half-white cards). Same as “pre-rendering” intermediate poses without extra GPU passes.
 */
/** Smaller slice = more spring substeps per frame (better continuity after fast drags). */
const FLIP_SPRING_DT_CAP = 1 / 960;
/**
 * Hard ceiling on |Δθ| per substep (button / keyboard spring can otherwise spike `vel` and still skip poses in one
 * slice). ~π/220 per substep @ 960Hz integration slices each frame’s dt — enough for a snappy flick,
 * not enough for single-step half-card cull.
 */
const FLIP_MAX_DANG_PER_SUBSTEP = Math.PI / 220;
/** Extra guard on angular velocity (rad/s) after spring acceleration each substep. */
const FLIP_MAX_ANG_VEL = 8.15;
/** Safety cap on substep iterations if `dt` is huge (tab backgrounded, etc.). */
const FLIP_SPRING_MAX_ITERS = 4000;
/** Cap how far `ang` can move per `pointermove` while dragging — coalesces fast pointer sweeps across frames. */
const FLIP_DRAG_ANG_STEP_CAP = 0.13;
/** Ignore noise when transferring drag-derived ω into the spring on `pointerup` (rad/s). */
const FLIP_DRAG_ANG_VEL_DEADBAND = 0.22;
/** How much of smoothed drag ω seeds `vel` at release (lower = softer handoff to spring). */
const FLIP_RELEASE_ANG_VEL_BLEND = 0.82;
/**
 * Near the closed/open target, clamp |ω| so the leaf eases into the stack instead of slamming
 * (reduces outer-cell depth / FrontSide glitches when releasing mid-flick).
 */
const FLIP_LANDING_WINDOW_RAD = Math.PI * 0.128;
/** Max |ω| (rad/s) when `|θ−tgt|` is inside the landing window (ramps up to `FLIP_MAX_ANG_VEL` outside). */
const FLIP_LANDING_MAX_ANG_VEL = 1.86;
/** After this many ms without `pointermove` during a peel, decay `dragAngVelSmooth` toward 0 (pause = less fling). */
const FLIP_DRAG_ANG_VEL_IDLE_MS = 52;

const BINDER_ORBIT_PITCH_MIN = -0.48;
const BINDER_ORBIT_PITCH_MAX = 0.4;
const BINDER_ORBIT_YAW_MAX = Math.PI / 6;
/** Equirectangular nebula sky for doctrine prematch room (wizard hut / portal). */
const BINDER_DOCTRINE_SKYBOX_URL = "/assets/binder/doctrine-skybox.png";

/**
 * Front hinge cover only — intentional “arcane portal” read (do not apply to shell / rear / pages).
 *
 * Why it happens:
 * - `createSkyPanorama` paints the nebula with `depthTest: false` + `renderOrder: -10000`, so it draws first
 *   and never occludes later geometry (see `render/skyPanorama.ts`).
 * - The outer leather box uses default `FrontSide` culling. With the cover swung open, the **outer** faces often
 *   point away from the camera → fragments are discarded → nothing overwrites those pixels, so the first-pass
 *   nebula shows through like a window (room GLB only covers rays that hit stone).
 *
 * We **reinforce** that behavior only on `_addFrontCover` materials: slight translucency + no depth write so the
 * cover never “masks” the sky in the depth buffer, without changing ring shell / tome back / folio.
 */
const BINDER_COVER_PORTAL_OPACITY = 0.94;
const BINDER_DOCTRINE_SKYBOX_RADIUS = 64;
const BINDER_DOCTRINE_SKYBOX_ZOOM = 1.55;
const BINDER_ROOM_PORTAL_URL = "/assets/binder/arcane_portal.glb";
const BINDER_ROOM_GLB_MAX_EXTENT = 11.5;
const BINDER_ROOM_GLB_CENTER = new THREE.Vector3(0, -0.85, -3.45);
const BINDER_FLOAT_Y = 0.18;
const BINDER_LOOK_AT = new THREE.Vector3(0, 0, 0);
const BINDER_DISPLAY_SCALE = 0.55;
/** v2 is the normal prematch layout key; v1 is migrated so the old `?binderCalibrate=1` pose becomes the landing page. */
const BINDER_PLACEMENT_STORAGE_KEY = "signalWarsBinderPlacement.v2";
const VIBE_PORTAL_PLACEMENT_STORAGE_KEY = "signalWarsVibePortalPlacement.v2";
const LEGACY_BINDER_PLACEMENT_STORAGE_KEY = "signalWarsBinderPlacement.v1";
const LEGACY_VIBE_PORTAL_PLACEMENT_STORAGE_KEY = "signalWarsVibePortalPlacement.v1";

export type BinderPlacement = { x: number; y: number; z: number; scale: number };
export type VibePortalPlacement = { x: number; y: number; z: number; rx: number; ry: number; rz: number; scale: number };
export type VibePortalAction = "enter";

/** Prematch “room scale” pose (binder over pedestal + foreground portal legibility). */
const DEFAULT_BINDER_PLACEMENT: BinderPlacement = { x: 0, y: 0.05, z: 0.12, scale: BINDER_DISPLAY_SCALE };
const DEFAULT_VIBE_PORTAL_PLACEMENT: VibePortalPlacement = {
  x: 0,
  y: 0.26,
  z: -1.86,
  rx: 0,
  ry: 0,
  rz: 0,
  scale: 1.05,
};

const roomLoader = new GLTFLoader();

function dragAngleShaped(raw: number): number {
  const r = THREE.MathUtils.clamp(raw, 0, Math.PI);
  const t = r / Math.PI;
  const s = t * t * (3.0 - 2.0 * t);
  return Math.PI * THREE.MathUtils.lerp(t, s, 0.38);
}

function readBinderPlacement(): BinderPlacement {
  if (typeof window === "undefined") return { ...DEFAULT_BINDER_PLACEMENT };
  try {
    const raw =
      window.localStorage.getItem(BINDER_PLACEMENT_STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_BINDER_PLACEMENT_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_BINDER_PLACEMENT };
    const parsed = JSON.parse(raw) as Partial<BinderPlacement>;
    const placement = {
      x: Number.isFinite(parsed.x) ? parsed.x! : DEFAULT_BINDER_PLACEMENT.x,
      y: Number.isFinite(parsed.y) ? parsed.y! : DEFAULT_BINDER_PLACEMENT.y,
      z: Number.isFinite(parsed.z) ? parsed.z! : DEFAULT_BINDER_PLACEMENT.z,
      scale: Number.isFinite(parsed.scale) ? THREE.MathUtils.clamp(parsed.scale!, 0.35, 0.78) : DEFAULT_BINDER_PLACEMENT.scale,
    };
    writeBinderPlacement(placement);
    return placement;
  } catch {
    return { ...DEFAULT_BINDER_PLACEMENT };
  }
}

function writeBinderPlacement(p: BinderPlacement): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(BINDER_PLACEMENT_STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

function readVibePortalPlacement(): VibePortalPlacement {
  if (typeof window === "undefined") return { ...DEFAULT_VIBE_PORTAL_PLACEMENT };
  try {
    const raw =
      window.localStorage.getItem(VIBE_PORTAL_PLACEMENT_STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_VIBE_PORTAL_PLACEMENT_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_VIBE_PORTAL_PLACEMENT };
    const parsed = JSON.parse(raw) as Partial<VibePortalPlacement>;
    const placement = {
      x: Number.isFinite(parsed.x) ? parsed.x! : DEFAULT_VIBE_PORTAL_PLACEMENT.x,
      y: Number.isFinite(parsed.y) ? parsed.y! : DEFAULT_VIBE_PORTAL_PLACEMENT.y,
      z: Number.isFinite(parsed.z) ? parsed.z! : DEFAULT_VIBE_PORTAL_PLACEMENT.z,
      rx: Number.isFinite(parsed.rx) ? parsed.rx! : DEFAULT_VIBE_PORTAL_PLACEMENT.rx,
      ry: Number.isFinite(parsed.ry) ? parsed.ry! : DEFAULT_VIBE_PORTAL_PLACEMENT.ry,
      rz: Number.isFinite(parsed.rz) ? parsed.rz! : DEFAULT_VIBE_PORTAL_PLACEMENT.rz,
      scale: Number.isFinite(parsed.scale)
        ? THREE.MathUtils.clamp(parsed.scale!, 0.45, 1.9)
        : DEFAULT_VIBE_PORTAL_PLACEMENT.scale,
    };
    writeVibePortalPlacement(placement);
    return placement;
  } catch {
    return { ...DEFAULT_VIBE_PORTAL_PLACEMENT };
  }
}

function writeVibePortalPlacement(p: VibePortalPlacement): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VIBE_PORTAL_PLACEMENT_STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
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

function makePortalTextPanel(text: string, width: number, height: number): THREE.Mesh {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, c.width, c.height);
  g.font = "900 46px system-ui, Segoe UI, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = "rgba(220, 250, 255, 0.98)";
  g.shadowColor = "rgba(0, 20, 48, 0.95)";
  g.shadowBlur = 16;
  g.fillText(text, c.width / 2, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), mat);
  mesh.renderOrder = 26;
  return mesh;
}

/** Shared leather look for shell + hinged front cover (Phase B). */
function createProceduralLeatherTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 512;
  const g = c.getContext("2d")!;
  paintBinderLeatherGrain(g, 512, 512);
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
  private readonly lookTarget = BINDER_LOOK_AT.clone();
  private readonly roomGroup = new THREE.Group();
  private readonly portalGroup = new THREE.Group();
  private readonly vibePortalGroup = new THREE.Group();
  private portalAssetRoot: THREE.Object3D | null = null;
  private readonly portalPulseMeshes: THREE.Mesh[] = [];
  /** Loaded nebula sky; disposed in `dispose()`. */
  private doctrineSkyboxTexture: THREE.Texture | null = null;
  private doctrineSkyboxMesh: SkyPanoramaMesh | null = null;
  private portalTransitionUntil = 0;
  private portalTransitionDuration = 0;
  private portalTransitionDirection: "in" | "out" | null = null;
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
  /** Rear exterior face only — leather + debossed “probably nothing”. */
  private readonly _tomeRearFaceTex: THREE.CanvasTexture;
  private readonly _shellMaterials: THREE.MeshStandardMaterial[] = [];
  private readonly _ownedLights: THREE.Light[] = [];
  private readonly pg: THREE.PlaneGeometry;
  private etex: THREE.CanvasTexture;
  private readonly cardBackTex: THREE.CanvasTexture;
  private ctex: THREE.Texture[];
  /** Per physical sheet: 18 catalog texture indices (0–8 front, 9–17 back). */
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
  private dist = 4.35;
  private yaw = 0;
  private pitch = -0.15;
  private readonly codexHandDragMode: boolean;
  /** Pick index where pointer down started on a card (LMB codex cell). */
  private armCatalogPickIndex: number | null = null;
  /** True after small drag threshold — emits `onCodexPointerDrag` instead of tap-assign. */
  private codexDragActive = false;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private binderPlacement = readBinderPlacement();
  private vibePortalPlacement = readVibePortalPlacement();
  /** Debug ingest throttle (`performance.now()` ms). */
  private _dbgFlipLogLast = 0;

  onPageChange: ((page: number, total: number) => void) | null = null;
  onPickCatalogIndex: ((index: number | null) => void) | null = null;
  /** Doctrine picker: recto catalog index selected by tap (`null` when cleared). */
  onCatalogSelectionChange: ((index: number | null) => void) | null = null;
  /** Doctrine picker: drag from codex toward DOM hand (start/move/end/cancel). */
  onCodexPointerDrag: ((ev: CodexPointerDragEvent) => void) | null = null;
  /** Fires when the binder crosses between closed and fully open (for UI hints). */
  onOpenStateChange: ((isOpen: boolean) => void) | null = null;
  /** Primary doctrine slot highlight clears when user presses empty folio (open + idle). */
  onClearDoctrineSelection: (() => void) | null = null;
  /** Easter egg: user tapped the leather rear board (orbit to see it). */
  onTomeBackTap: (() => void) | null = null;

  private flipArm: "next" | "prev" | null = null;
  private armSX = 0;
  private armSY = 0;
  /** Pointer down began on a recto card cell — blocks page-turn arming; large move cancels tap. */
  private pendingCardTap = false;
  private readonly FLIP_ARM_PX = 10;
  private readonly TAP_MAX_PX = 14;
  /** Doctrine picker: hold still on a recto cell before lift + drag. */
  private readonly CODEX_LONG_PRESS_MS = 400;
  /** Slop while waiting for long-press (must exceed `FLIP_ARM_PX` so tap-cancel does not kill the hold). */
  private readonly CODEX_LONG_PRESS_SLOP_PX = 22;
  /** Same-cell drag distance that lifts immediately (doctrine picker; avoids relying only on long-press). */
  private readonly CODEX_MOVE_PULL_PX = 16;
  private _codexLongPressTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  /** Recto cell index last chosen by tap (picker). */
  private selectedCatalogPickIndex: number | null = null;
  /** Recto cells showing sleeve card-back while the face is dragged away. */
  private readonly codexPulledPickIndices = new Set<number>();
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
  /** Smoothed dθ/dt while dragging a peel (rad/s); seeds spring `vel` on release. */
  private dragAngVelSmooth = 0;
  private dragAngVelPrevAng = 0;
  private dragAngVelPrevT = 0;
  private lastMoveClientX = 0;
  private lastMoveT = 0;
  private _lastMechTe = 0;
  private _metalTickDoneForOpen = false;
  /** Shared thin quads faking page block thickness under static spreads. */
  private readonly paperStackGeo: THREE.PlaneGeometry;

  constructor(canvas: HTMLCanvasElement, textures: THREE.Texture[], opts?: CardBinderEngineOptions) {
    this.codexHandDragMode = opts?.codexHandDragMode === true;
    const controlProfile = opts?.controlProfile ?? getControlProfile();
    this.pageAudio = new BinderPageAudio();

    this.R = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
      /** Reduces folio / page / slot Z sparkles when many coplanar-ish surfaces stack (binder only uses this renderer). */
      logarithmicDepthBuffer: true,
    });
    this.R.setPixelRatio(Math.min(devicePixelRatio, controlProfile.binderMaxPixelRatio));
    this.R.outputColorSpace = THREE.SRGBColorSpace;
    this.R.toneMapping = THREE.ACESFilmicToneMapping;
    /** Leather shell only — catalog panels use `toneMapped:false` so ACES + high exposure cannot crush sleeve art to black. */
    this.R.toneMappingExposure = 1.02;
    this.R.setClearColor(BINDER_CFG.bg, 1);

    this.S = new THREE.Scene();
    this.S.background = new THREE.Color(BINDER_CFG.bg);
    void this._loadDoctrineSkybox();
    /** Tighter near plane with log depth improves precision for stacked folio pages without clipping the shell. */
    this.cam = new THREE.PerspectiveCamera(40, 1, 0.04, 80);
    this.cam.position.set(0, -0.65, 5.7);
    this.cam.lookAt(this.lookTarget);

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
    this.G.position.y = BINDER_FLOAT_Y;
    this._addBinderRoomSet();
    this.S.add(this.roomGroup);
    this.S.add(this.G);

    this._sharedLeatherTex = createProceduralLeatherTexture();
    const PH0 = BINDER_CFG.pageHeight;
    const PW0 = BINDER_CFG.pageWidth;
    const spreadW0 = PW0 * 2 + 0.44;
    const spreadH0 = PH0 + 0.34;
    this._tomeRearFaceTex = createTomeRearBoardFaceTexture(spreadW0, spreadH0);

    this.tomeBackGroup.name = "binder_tome_back";
    this.tomeBackGroup.renderOrder = -30;
    this.G.add(this.tomeBackGroup);
    this._addTomeBackPlate(this.tomeBackGroup, this._sharedLeatherTex, this._tomeRearFaceTex);

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
    void this._loadPortalAsset();
    this._tick = this._tick.bind(this);
    requestAnimationFrame(this._tick);
  }

  private _addBinderRoomSet(): void {
    this.roomGroup.name = "binder_arcane_room";
    this.roomGroup.renderOrder = -80;

    this._addVibePortalSet();
    this.roomGroup.add(this.portalGroup);
    this.roomGroup.add(this.vibePortalGroup);
  }

  private _addVibePortalSet(): void {
    this.vibePortalGroup.name = "vibe_jam_foreground_portal";
    this.vibePortalGroup.renderOrder = 20;

    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(1.02, 96),
      new THREE.MeshBasicMaterial({
        color: 0x48c9ff,
        transparent: true,
        opacity: 0.14,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    );
    disc.name = "vibe_jam_portal_enter_disc";
    disc.userData.vibePortalAction = "enter" satisfies VibePortalAction;
    disc.renderOrder = 20;
    this.vibePortalGroup.add(disc);
    this.portalPulseMeshes.push(disc);

    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.7 + i * 0.16, 0.74 + i * 0.16, 96),
        new THREE.MeshBasicMaterial({
          color: i === 0 ? 0xd8fbff : i === 1 ? 0x52d6ff : 0x286dff,
          transparent: true,
          opacity: 0.58 - i * 0.08,
          depthWrite: false,
          depthTest: true,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        }),
      );
      ring.name = `vibe_jam_portal_enter_ring_${i}`;
      ring.userData.vibePortalAction = "enter" satisfies VibePortalAction;
      ring.userData.portalRingIndex = i + 10;
      ring.renderOrder = 21 + i;
      this.vibePortalGroup.add(ring);
      this.portalPulseMeshes.push(ring);
    }

    const enter = makePortalTextPanel("NEXT GAME", 1.25, 0.25);
    enter.position.set(0, 0.08, 0.035);
    enter.userData.vibePortalAction = "enter" satisfies VibePortalAction;
    this.vibePortalGroup.add(enter);
    this._applyVibePortalTransform();
  }

  /** Nebula equirectangular sky behind the doctrine prematch room (falls back to parchment clear color). Pair with hinged cover “portal” (`createSkyPanorama`: depth tests off, draws first). */
  private async _loadDoctrineSkybox(): Promise<void> {
    const loader = new THREE.TextureLoader();
    try {
      const tex = await loader.loadAsync(BINDER_DOCTRINE_SKYBOX_URL);
      if (this.disposed) {
        tex.dispose();
        return;
      }
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.mapping = THREE.EquirectangularReflectionMapping;
      // Full-screen equirect backgrounds look mushy with mipmaps (wrong mip chain for this projection).
      // Stay on `scene.background` (not a sky sphere) so nothing can intersect the near plane.
      tex.generateMipmaps = false;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.anisotropy = Math.min(16, this.R.capabilities.getMaxAnisotropy());
      this.doctrineSkyboxTexture?.dispose();
      this.doctrineSkyboxTexture = tex;
      if (this.doctrineSkyboxMesh) {
        this.S.remove(this.doctrineSkyboxMesh);
        this.doctrineSkyboxMesh.geometry.dispose();
        this.doctrineSkyboxMesh.material.dispose();
      }
      this.doctrineSkyboxMesh = createSkyPanorama(tex, {
        radius: BINDER_DOCTRINE_SKYBOX_RADIUS,
        zoom: BINDER_DOCTRINE_SKYBOX_ZOOM,
      });
      this.S.add(this.doctrineSkyboxMesh);
      this.S.background = new THREE.Color(BINDER_CFG.bg);
    } catch {
      /* Missing URL or decode failure — keep `BINDER_CFG.bg`. */
    }
  }

  private async _loadPortalAsset(): Promise<void> {
    try {
      const gltf = await roomLoader.loadAsync(BINDER_ROOM_PORTAL_URL);
      if (this.disposed) {
        this._disposeObject(gltf.scene);
        return;
      }
      const root = gltf.scene;
      root.name = "arcane_portal_glb";
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || !mesh.material) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const raw of mats) {
          const mat = raw as THREE.MeshStandardMaterial;
          if (mat.isMeshStandardMaterial) {
            mat.emissive = mat.emissive ?? new THREE.Color(0x000000);
            mat.emissive.lerp(new THREE.Color(0x6b38ff), 0.28);
            mat.emissiveIntensity = Math.max(mat.emissiveIntensity ?? 0, 0.18);
          }
        }
      });
      this._fitPortalAsset(root);
      this.portalAssetRoot = root;
      this.portalGroup.add(root);
    } catch {
      /* Fallback rings still provide the room portal if the GLB fails. */
    }
  }

  private _fitPortalAsset(root: THREE.Object3D): void {
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const max = Math.max(size.x, size.y, size.z, 1e-3);
    const scale = BINDER_ROOM_GLB_MAX_EXTENT / max;
    root.scale.setScalar(scale);
    root.position.set(
      BINDER_ROOM_GLB_CENTER.x - center.x * scale,
      BINDER_ROOM_GLB_CENTER.y - center.y * scale,
      BINDER_ROOM_GLB_CENTER.z - center.z * scale,
    );
  }

  private _withTestPagePadding(incoming: THREE.Texture[]): THREE.Texture[] {
    const targetPanels = BINDER_CODEX_TOTAL_CELLS;
    const extra = BINDER_TEST_EXTRA_PAGES * BINDER_CELLS_PER_SHEET;

    if (incoming.length === 0) {
      const out: THREE.Texture[] = [];
      while (out.length < targetPanels) out.push(this.etex);
      for (let i = 0; i < extra; i++) out.push(this.etex);
      return out;
    }

    if (incoming.length >= targetPanels) {
      const out = incoming.slice(0, targetPanels);
      for (let i = 0; i < extra; i++) out.push(this.etex);
      return out;
    }

    const base = [...incoming];
    for (let i = base.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [base[i], base[j]] = [base[j]!, base[i]!];
    }
    const out: THREE.Texture[] = [];
    for (let k = 0; k < targetPanels; k++) {
      out.push(base[k % base.length]!);
    }
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    for (let e = 0; e < extra; e++) out.push(this.etex);
    return out;
  }

  private _emptyChunk(): number[] {
    return Array.from({ length: BINDER_CELLS_PER_SHEET }, () => -1);
  }

  /** Nine empty catalog slots (one 3×3 face). */
  private _nineEmpty(): number[] {
    return Array.from({ length: BINDER_CELLS_PER_PAGE }, () => -1);
  }

  private _sheetFront9(chunkIdx: number): number[] {
    const ch = this.chunks[chunkIdx];
    if (!ch) return this._nineEmpty();
    return Array.from({ length: BINDER_CELLS_PER_PAGE }, (_, k) => ch[k] ?? -1);
  }

  private _sheetBack9(chunkIdx: number): number[] {
    const ch = this.chunks[chunkIdx];
    if (!ch) return this._nineEmpty();
    return Array.from({ length: BINDER_CELLS_PER_PAGE }, (_, k) => ch[BINDER_CELLS_PER_PAGE + k] ?? -1);
  }

  private _chunkHasCards(idx: readonly number[]): boolean {
    return idx.some((ix) => ix >= 0);
  }

  private _mkChunks(): number[][] {
    const n = this.ctex.length;
    const cell = BINDER_CELLS_PER_SHEET;
    const out: number[][] = [];
    for (let i = 0; i < n; i += cell) {
      out.push(
        Array.from({ length: cell }, (_, k) => {
          const ix = i + k;
          if (ix >= n) return -1;
          return ix;
        }),
      );
    }
    while (out.length > 0) {
      const tail = out[out.length - 1]!;
      if (this._chunkHasCards(tail)) break;
      out.pop();
    }
    if (out.length === 0) {
      out.push(this._emptyChunk());
    }
    /** Trailing all-empty sheets are dropped above; pad back to `BINDER_CODEX_SPREAD_COUNT` so navigation always has that many turnable spreads. */
    while (out.length < BINDER_CODEX_SPREAD_COUNT) {
      out.push(this._emptyChunk());
    }
    return out;
  }

  /**
   * Left half of spread `chunkIdx`: camera sees the **back** (indices 9–17) of sheet `chunkIdx - 1`;
   * the hidden face is that sheet’s **front** (0–8).
   */
  private _leftSpread(chunkIdx: number): { toward: number[]; paired: number[] } | null {
    if (chunkIdx <= 0) return null;
    return {
      toward: this._sheetBack9(chunkIdx - 1),
      paired: this._sheetFront9(chunkIdx - 1),
    };
  }

  /** Catalog / sleeve quads — unlit; `toneMapped:false` keeps CanvasTexture art readable under ACES on the renderer. */
  private _matPanel(
    map: THREE.Texture,
    opts?: { flipU?: boolean; flipV?: boolean; side?: THREE.Side },
  ): THREE.MeshBasicMaterial {
    let tex: THREE.Texture = map;
    if (opts?.flipU || opts?.flipV) {
      tex = map.clone();
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.repeat.set(opts.flipU ? -1 : 1, opts.flipV ? -1 : 1);
      tex.offset.set(opts.flipU ? 1 : 0, opts.flipV ? 1 : 0);
      tex.needsUpdate = true;
    }
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      side: opts?.side ?? THREE.DoubleSide,
      toneMapped: false,
      transparent: false,
      opacity: 1,
      depthWrite: true,
      depthTest: true,
      polygonOffset: false,
    });
    return mat;
  }

  /** Rear board + spine — the “outer” tome you feel behind the folio. */
  private _addTomeBackPlate(
    parent: THREE.Group,
    leatherMap: THREE.CanvasTexture,
    rearFaceMap: THREE.CanvasTexture,
  ): void {
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
    /** World Z of the leather slab’s outer (back) face — plane was coplanar / inside → z-fight + no read. */
    const backOuterZ = -0.132 - backDepth * 0.5;
    const back = new THREE.Mesh(new THREE.BoxGeometry(spreadW, spreadH, backDepth), leather);
    back.name = "binder_tome_rear_leather_block";
    back.renderOrder = 0;
    back.position.set(0, 0, -0.132);
    parent.add(back);

    const rearFace = new THREE.MeshStandardMaterial({
      map: rearFaceMap,
      side: THREE.DoubleSide,
      roughness: 0.22,
      metalness: 0.78,
      emissive: new THREE.Color(0xc9a050),
      emissiveIntensity: 0.26,
      envMapIntensity: 1.15,
      polygonOffset: false,
      depthWrite: true,
      depthTest: true,
    });
    this._shellMaterials.push(rearFace);
    const rearArt = new THREE.Mesh(
      new THREE.PlaneGeometry(spreadW * 0.992, spreadH * 0.992),
      rearFace,
    );
    rearArt.name = "binder_tome_rear_tooled_face";
    rearArt.renderOrder = 12;
    /** Past the leather outer face (−Z), not coplanar / inside the box (avoids z-fighting). */
    const goldStandoff = 0.022;
    rearArt.position.set(0, 0, backOuterZ - goldStandoff);
    /** Y-flip (not X) keeps the canvas right-way-up with `rearFaceMap.flipY = false` in tome art. */
    rearArt.rotation.set(0, Math.PI, 0);
    parent.add(rearArt);

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
      ...this._coverPortalMaterialOpts(),
    });
    this._coverBoardMat = boardMat;

    const board = new THREE.Mesh(new THREE.BoxGeometry(thick, PH + 0.28, spanZ), boardMat);
    board.position.set(thick / 2 + 0.02, 0, 0);
    board.renderOrder = 2;
    board.userData.binderCoverPortalShell = true;
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
      ...this._coverPortalMaterialOpts(),
    });
    const deco = new THREE.Mesh(
      new THREE.PlaneGeometry(spanZ * 0.9, (PH + 0.28) * 0.86),
      this._coverDecoMat,
    );
    deco.position.set(thick + 0.02 + 0.0035, 0, 0);
    deco.rotation.y = Math.PI / 2;
    deco.renderOrder = 4;
    deco.userData.binderCoverPortalShell = true;
    hinge.add(deco);
  }

  /** Cover-only: keeps the nebula “portal” readable (see header comment by `BINDER_COVER_PORTAL_OPACITY`). */
  private _coverPortalMaterialOpts(): Pick<
    THREE.MeshStandardMaterialParameters,
    "side" | "transparent" | "opacity" | "depthWrite" | "depthTest"
  > {
    return {
      side: THREE.FrontSide,
      transparent: true,
      opacity: BINDER_COVER_PORTAL_OPACITY,
      depthWrite: false,
      depthTest: true,
    };
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
   * One half-page: nine recto slots (`toward`) + nine verso slots (`paired`) on the **same physical sheet**
   * (front row of indices 0–8 and back row 9–17 in the chunk). Same code path for static spread and flip leaf.
   *
   * `layoutMeta` assigns stable 1-based tooling ids per physical sheet: slots 1–9 on the sheet’s front face,
   * 10–18 on its back; each additional sheet adds 18 (`sheetIndex` is 0-based).
   *
   * **Left half (`side === -1`):** `_cellLocalX` mirrors columns vs the right half so the gutter stays correct.
   * Chunk `toward` / `paired` stay in the same row-major order as the physical sheet; we index them with
   * `kData = row*3 + (2 - col)` so each mesh cell still shows the pocket that was under it during a peel
   * (avoids left↔right column “fire drill” when `_v` rebuilds after a flip).
   */
  private _pageSheet(
    toward: number[],
    paired: number[],
    side: 1 | -1,
    meshRenderOrder: number,
    layoutMeta?: { sheetIndex: number; rectoIsPhysicalBack: boolean },
  ): THREE.Group {
    const g = new THREE.Group();
    if (layoutMeta && layoutMeta.sheetIndex >= 0) {
      g.userData.binderSheetIndex = layoutMeta.sheetIndex;
    }
    g.add(this._makeHalfPagePaperBacking(side));
    for (let r = 0; r < BINDER_ROWS; r++) {
      for (let c = 0; c < BINDER_COLS; c++) {
        const kMesh = CardBinderEngine._cellIndex(r, c);
        const cData = side < 0 ? BINDER_COLS - 1 - c : c;
        const kData = CardBinderEngine._cellIndex(r, cData);
        const ti = toward[kData]!;
        const pi = paired[kData]!;
        const frontT = this._gT(ti);
        const backT = pi >= 0 ? this._gT(pi) : this._gT(-1);
        let globalRecto1: number | undefined;
        let globalVerso1: number | undefined;
        if (layoutMeta && layoutMeta.sheetIndex >= 0) {
          const b = layoutMeta.sheetIndex * BINDER_CELLS_PER_SHEET;
          if (layoutMeta.rectoIsPhysicalBack) {
            globalRecto1 = b + BINDER_CELLS_PER_PAGE + 1 + kData;
            globalVerso1 = b + 1 + kData;
          } else {
            globalRecto1 = b + 1 + kData;
            globalVerso1 = b + BINDER_CELLS_PER_PAGE + 1 + kData;
          }
        }
        const cell = this._binderCellPair(
          frontT,
          backT,
          ti,
          meshRenderOrder,
          pi >= 0 ? pi : undefined,
          kMesh,
          side,
          globalRecto1,
          globalVerso1,
        );
        cell.position.set(this._cellLocalX(c, side), this._rY(r), 0);
        cell.userData.gridRow = r;
        cell.userData.gridCol = c;
        cell.userData.cellIndex = kMesh;
        g.add(cell);
      }
    }
    return g;
  }

  private _sp(
    toward: number[],
    paired: number[],
    side: number,
    meshRenderOrder = 3,
    layoutMeta?: { sheetIndex: number; rectoIsPhysicalBack: boolean },
  ): THREE.Group {
    const s = side > 0 ? 1 : -1;
    return this._pageSheet(toward, paired, s, meshRenderOrder, layoutMeta);
  }

  /**
   * One catalog duplex: recto + verso are two parallel card quads (magnet front/back), sharing the cell’s XY plane.
   * Static spread and turning leaf use the same render order so resting vs flip never “swaps” depth ordering.
   */
  private _binderCellPair(
    frontTex: THREE.Texture,
    backTex: THREE.Texture,
    rectoPickIndex: number,
    _meshRenderOrder: number,
    versoPickIndex: number | undefined,
    slotDepthIndex: number,
    _halfPageSide: 1 | -1,
    globalRectoSlot1Based?: number,
    globalVersoSlot1Based?: number,
  ): THREE.Group {
    const cell = new THREE.Group();
    const half = MAGNET_FACE_GAP * 0.5;
    const zBias = slotDepthIndex * MAGNET_SLOT_Z_STAGGER;
    const roFront = 112 + slotDepthIndex * 0.00012;
    const roBack = 108 + slotDepthIndex * 0.00012;

    const rectoPulled =
      this.codexHandDragMode && rectoPickIndex >= 0 && this.codexPulledPickIndices.has(rectoPickIndex);
    const frontFaceTex = rectoPulled ? this.cardBackTex : frontTex;

    const front = new THREE.Mesh(this.pg, this._matPanel(frontFaceTex, { side: THREE.FrontSide }));
    front.position.z = half + zBias;
    front.renderOrder = roFront;
    front.userData.pickIndex = rectoPickIndex;
    front.userData.gridPick = rectoPickIndex >= 0 && !rectoPulled;
    front.userData.binderFace = "recto" as const;
    front.userData.binderRole = "slot_recto" as const;
    if (rectoPickIndex >= 0) front.userData.catalogIndex = rectoPickIndex;
    if (globalRectoSlot1Based !== undefined) front.userData.binderGlobalSlot1Based = globalRectoSlot1Based;

    /**
     * Verso quad is rotated 180° about X so it faces the opposite way from recto. Flip U+V so catalog / sleeve
     * art reads left-to-right and upright when that face is toward the camera (same convention both half-pages).
     */
    const back = new THREE.Mesh(
      this.pg,
      this._matPanel(backTex, { flipV: true, flipU: true, side: THREE.FrontSide }),
    );
    back.position.z = -half - zBias;
    back.rotation.x = Math.PI;
    back.renderOrder = roBack;
    back.userData.binderFace = "verso" as const;
    back.userData.binderRole = "slot_verso" as const;
    if (versoPickIndex !== undefined && versoPickIndex >= 0) {
      back.userData.pickIndex = versoPickIndex;
      back.userData.catalogIndex = versoPickIndex;
    }
    if (globalVersoSlot1Based !== undefined) back.userData.binderGlobalSlot1Based = globalVersoSlot1Based;

    back.visible = !rectoPulled;

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
      if (o.isMesh && o.userData._doctrineBadge) this._stripDoctrineBadge(o);
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
      this.lp = this._sp(left.toward, left.paired, -1, 3, { sheetIndex: s - 1, rectoIsPhysicalBack: true });
      this.lp.position.z = PAGE_SURFACE_Z;
      this._addPaperStackUnder(this.lp, -BINDER_CFG.pageWidth / 2);
      this.innerGroup.add(this.lp);
      this.lp.renderOrder = PAGE_RENDER_REST;
    } else if (s === 0) {
      /** First spread: `_leftSpread(0)` is null — still draw the left leaf so both halves read as a folio. */
      this.lp = this._sp(this._nineEmpty(), this._nineEmpty(), -1);
      this.lp.position.z = PAGE_SURFACE_Z;
      this._addPaperStackUnder(this.lp, -BINDER_CFG.pageWidth / 2);
      this.innerGroup.add(this.lp);
      this.lp.renderOrder = PAGE_RENDER_REST;
    }
    if (this.chunks[s]) {
      this.rp = this._sp(this._sheetFront9(s), this._sheetBack9(s), 1, 3, { sheetIndex: s, rectoIsPhysicalBack: false });
      this.rp.position.z = PAGE_SURFACE_Z;
      this._addPaperStackUnder(this.rp, BINDER_CFG.pageWidth / 2);
      this.innerGroup.add(this.rp);
      this.rp.renderOrder = PAGE_RENDER_REST;
    }
    this._notifyPage();
    this._refreshBinderFaceDecor();
    this._syncMarginHits();
  }

  private _sf(): void {
    // #region agent log
    fetch("http://127.0.0.1:7536/ingest/bef92781-28ef-46f8-965d-ec6701871e09", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "b91e25" },
      body: JSON.stringify({
        sessionId: "b91e25",
        hypothesisId: "flip",
        location: "CardBinderEngine.ts:_sf",
        message: "flip_layout_start",
        data: { cur: this.cur, fl: this.fl, drag: this.drag },
        timestamp: Date.now(),
        runId: "binder-retest",
      }),
    }).catch(() => {});
    // #endregion
    this._cl(this.fp);
    this.fp = null;
    const s = this.cur;
    if (this.fl === 1 && this.chunks[s]) {
      /**
       * Keep the **current** left leaf for the whole peel — do not swap it to `_leftSpread(s + 1)`.
       * Preloading the destination left made spread 0 look broken: empty left suddenly filled with `chunks[0]`
       * while the user was still dragging the right page (same art as the turning leaf, felt “random”).
       * After `_done`, `_v()` builds the correct left for `cur === s + 1`.
       */
      if (this.lp) {
        this.lp.position.z = PAGE_SURFACE_Z - UNDER_PAGE_Z_LIFT;
        this.lp.renderOrder = PAGE_RENDER_UNDER;
      } else {
        this.lp = this._sp(this._nineEmpty(), this._nineEmpty(), -1, 1);
        this.lp.position.z = PAGE_SURFACE_Z - UNDER_PAGE_Z_LIFT;
        this.lp.renderOrder = PAGE_RENDER_UNDER;
        this.innerGroup.add(this.lp);
      }
      /** Reuse the resting right half as the turning leaf so textures and layout match the spread exactly. */
      if (this.rp) {
        this.fp = this.rp;
        this.rp = null;
        this.fp.position.set(FLIP_LEAF_HINGE_X, 0, PAGE_SURFACE_Z + FLIP_LEAF_Z_EPS);
        this.fp.rotation.set(0, 0, 0);
        this.fp.renderOrder = PAGE_RENDER_TURNING;
        this.innerGroup.remove(this.fp);
        this.innerGroup.add(this.fp);
      } else {
        this.fp = this._pageSheet(this._sheetFront9(s), this._sheetBack9(s), 1, 5, {
          sheetIndex: s,
          rectoIsPhysicalBack: false,
        });
        this.fp.position.set(FLIP_LEAF_HINGE_X, 0, PAGE_SURFACE_Z + FLIP_LEAF_Z_EPS);
        this.fp.renderOrder = PAGE_RENDER_TURNING;
        this.innerGroup.add(this.fp);
      }
      if (this.chunks[s + 1]) {
        const nx = s + 1;
        this.rp = this._sp(this._sheetFront9(nx), this._sheetBack9(nx), 1, 1, {
          sheetIndex: nx,
          rectoIsPhysicalBack: false,
        });
        this.rp.position.z = PAGE_SURFACE_Z - UNDER_PAGE_Z_LIFT;
        this.rp.renderOrder = PAGE_RENDER_UNDER;
        this.innerGroup.add(this.rp);
      }
      this._refreshBinderFaceDecor();
    }
    if (this.fl === -1 && this.chunks[s - 1]) {
      const dest = s - 1;
      /** Reuse the resting left half (back-of-sheet recto) — must match `_leftSpread(s)`, not front/back swapped. */
      if (this.lp) {
        this.fp = this.lp;
        this.lp = null;
        this.fp.position.set(FLIP_LEAF_HINGE_X, 0, PAGE_SURFACE_Z + FLIP_LEAF_Z_EPS);
        this.fp.rotation.set(0, 0, 0);
        this.fp.renderOrder = PAGE_RENDER_TURNING;
        this.innerGroup.remove(this.fp);
        this.innerGroup.add(this.fp);
      } else {
        this.fp = this._pageSheet(this._sheetBack9(s - 1), this._sheetFront9(s - 1), -1, 5, {
          sheetIndex: s - 1,
          rectoIsPhysicalBack: true,
        });
        this.fp.position.set(FLIP_LEAF_HINGE_X, 0, PAGE_SURFACE_Z + FLIP_LEAF_Z_EPS);
        this.fp.renderOrder = PAGE_RENDER_TURNING;
        this.innerGroup.add(this.fp);
      }
      if (this.rp) this.rp.renderOrder = PAGE_RENDER_REST;
      /**
       * Keep the **current** right leaf for the whole peel (same idea as flip-next keeping the old left leaf).
       * Swapping `rp` to the destination spread here made the whole right half jump to the “previous” page
       * instantly while only the left side was animating.
       */
      const ll = this._leftSpread(dest);
      if (ll) {
        this.lp = this._sp(ll.toward, ll.paired, -1, 1, { sheetIndex: dest - 1, rectoIsPhysicalBack: true });
        this.lp.position.z = PAGE_SURFACE_Z - UNDER_PAGE_Z_LIFT;
        this.lp.renderOrder = PAGE_RENDER_UNDER;
        this.innerGroup.add(this.lp);
      } else if (dest === 0) {
        /** Match `_v` for spread 0 — otherwise the left folio is missing for the whole peel and cards read “wrong”. */
        this.lp = this._sp(this._nineEmpty(), this._nineEmpty(), -1, 1);
        this.lp.position.z = PAGE_SURFACE_Z - UNDER_PAGE_Z_LIFT;
        this.lp.renderOrder = PAGE_RENDER_UNDER;
        this.innerGroup.add(this.lp);
      }
      this._refreshBinderFaceDecor();
    }
    this._syncMarginHits();
  }

  private _aa(a: number): void {
    if (!this.fp) return;
    this.fp.rotation.y = this.fl === 1 ? -a : a;
    const sn = Math.sin(a);
    const lift = sn * (1.0 - Math.cos(a)) * 0.5;
    this.fp.position.x = FLIP_LEAF_HINGE_X;
    this.fp.position.z = PAGE_SURFACE_Z + FLIP_LEAF_Z_EPS + 0.048 * lift;
  }

  private _done(): void {
    // #region agent log
    fetch("http://127.0.0.1:7536/ingest/bef92781-28ef-46f8-965d-ec6701871e09", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "b91e25" },
      body: JSON.stringify({
        sessionId: "b91e25",
        hypothesisId: "flip",
        location: "CardBinderEngine.ts:_done",
        message: "flip_complete",
        data: { fl: this.fl, curBefore: this.cur, ang: this.ang, vel: this.vel },
        timestamp: Date.now(),
        runId: "binder-retest",
      }),
    }).catch(() => {});
    // #endregion
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
    // #region agent log
    fetch("http://127.0.0.1:7536/ingest/bef92781-28ef-46f8-965d-ec6701871e09", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "b91e25" },
      body: JSON.stringify({
        sessionId: "b91e25",
        hypothesisId: "flip",
        location: "CardBinderEngine.ts:_canc",
        message: "flip_cancel",
        data: { cur: this.cur, ang: this.ang },
        timestamp: Date.now(),
        runId: "binder-retest",
      }),
    }).catch(() => {});
    // #endregion
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
    if (this.cur >= this.chunks.length - 1) return;
    // #region agent log
    fetch("http://127.0.0.1:7536/ingest/bef92781-28ef-46f8-965d-ec6701871e09", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "b91e25" },
      body: JSON.stringify({
        sessionId: "b91e25",
        hypothesisId: "flip",
        location: "CardBinderEngine.ts:flipNext",
        message: "flip_next_ui",
        data: { cur: this.cur },
        timestamp: Date.now(),
        runId: "binder-retest",
      }),
    }).catch(() => {});
    // #endregion
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
    if (this.cur <= 0) return;
    // #region agent log
    fetch("http://127.0.0.1:7536/ingest/bef92781-28ef-46f8-965d-ec6701871e09", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "b91e25" },
      body: JSON.stringify({
        sessionId: "b91e25",
        hypothesisId: "flip",
        location: "CardBinderEngine.ts:flipPrev",
        message: "flip_prev_ui",
        data: { cur: this.cur },
        timestamp: Date.now(),
        runId: "binder-retest",
      }),
    }).catch(() => {});
    // #endregion
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

  getBinderPlacement(): BinderPlacement {
    return { ...this.binderPlacement };
  }

  setBinderPlacement(next: Partial<BinderPlacement>, persist = true): BinderPlacement {
    this.binderPlacement = {
      x: Number.isFinite(next.x) ? next.x! : this.binderPlacement.x,
      y: Number.isFinite(next.y) ? next.y! : this.binderPlacement.y,
      z: Number.isFinite(next.z) ? next.z! : this.binderPlacement.z,
      scale: Number.isFinite(next.scale) ? THREE.MathUtils.clamp(next.scale!, 0.35, 0.78) : this.binderPlacement.scale,
    };
    if (persist) writeBinderPlacement(this.binderPlacement);
    this._applyBinderTransform();
    return this.getBinderPlacement();
  }

  resetBinderPlacement(): BinderPlacement {
    this.binderPlacement = { ...DEFAULT_BINDER_PLACEMENT };
    writeBinderPlacement(this.binderPlacement);
    this._applyBinderTransform();
    return this.getBinderPlacement();
  }

  getVibePortalPlacement(): VibePortalPlacement {
    return { ...this.vibePortalPlacement };
  }

  setVibePortalPlacement(next: Partial<VibePortalPlacement>, persist = true): VibePortalPlacement {
    this.vibePortalPlacement = {
      x: Number.isFinite(next.x) ? next.x! : this.vibePortalPlacement.x,
      y: Number.isFinite(next.y) ? next.y! : this.vibePortalPlacement.y,
      z: Number.isFinite(next.z) ? next.z! : this.vibePortalPlacement.z,
      rx: Number.isFinite(next.rx) ? next.rx! : this.vibePortalPlacement.rx,
      ry: Number.isFinite(next.ry) ? next.ry! : this.vibePortalPlacement.ry,
      rz: Number.isFinite(next.rz) ? next.rz! : this.vibePortalPlacement.rz,
      scale: Number.isFinite(next.scale)
        ? THREE.MathUtils.clamp(next.scale!, 0.45, 1.9)
        : this.vibePortalPlacement.scale,
    };
    if (persist) writeVibePortalPlacement(this.vibePortalPlacement);
    this._applyVibePortalTransform();
    return this.getVibePortalPlacement();
  }

  resetVibePortalPlacement(): VibePortalPlacement {
    this.vibePortalPlacement = { ...DEFAULT_VIBE_PORTAL_PLACEMENT };
    writeVibePortalPlacement(this.vibePortalPlacement);
    this._applyVibePortalTransform();
    return this.getVibePortalPlacement();
  }

  projectBinderAnchor(rect: DOMRect): { x: number; y: number } {
    const p = this.G.getWorldPosition(new THREE.Vector3()).project(this.cam);
    return {
      x: rect.left + (p.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-p.y * 0.5 + 0.5) * rect.height,
    };
  }

  alignBinderAnchorToClient(clientX: number, clientY: number, rect: DOMRect): BinderPlacement {
    const anchor = this.projectBinderAnchor(rect);
    return this.nudgeBinderByScreenPixels(clientX - anchor.x, clientY - anchor.y, rect);
  }

  nudgeBinderByScreenPixels(dxPx: number, dyPx: number, rect: DOMRect): BinderPlacement {
    this.cam.updateMatrixWorld(true);
    this.G.updateMatrixWorld(true);
    const anchor = this.G.getWorldPosition(new THREE.Vector3());
    const distance = Math.max(0.1, anchor.distanceTo(this.cam.position));
    const unitsPerPx = (2 * Math.tan(THREE.MathUtils.degToRad(this.cam.fov) * 0.5) * distance) / Math.max(1, rect.height);
    const right = new THREE.Vector3().setFromMatrixColumn(this.cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.cam.matrixWorld, 1);
    const disp = right.multiplyScalar(dxPx * unitsPerPx).add(up.multiplyScalar(-dyPx * unitsPerPx));
    return this.setBinderPlacement({
      x: this.binderPlacement.x + disp.x,
      y: this.binderPlacement.y + disp.y,
      z: this.binderPlacement.z + disp.z,
    });
  }

  nudgeBinderDepth(delta: number): BinderPlacement {
    return this.setBinderPlacement({ z: this.binderPlacement.z + delta });
  }

  nudgeVibePortal(delta: Partial<VibePortalPlacement>): VibePortalPlacement {
    return this.setVibePortalPlacement({
      x: this.vibePortalPlacement.x + (delta.x ?? 0),
      y: this.vibePortalPlacement.y + (delta.y ?? 0),
      z: this.vibePortalPlacement.z + (delta.z ?? 0),
      rx: this.vibePortalPlacement.rx + (delta.rx ?? 0),
      ry: this.vibePortalPlacement.ry + (delta.ry ?? 0),
      rz: this.vibePortalPlacement.rz + (delta.rz ?? 0),
      scale: this.vibePortalPlacement.scale + (delta.scale ?? 0),
    });
  }

  alignVibePortalToClient(clientX: number, clientY: number, rect: DOMRect): VibePortalPlacement {
    this.cam.updateMatrixWorld(true);
    this.vibePortalGroup.updateMatrixWorld(true);
    const anchor = this.vibePortalGroup.getWorldPosition(new THREE.Vector3());
    const projected = anchor.clone().project(this.cam);
    const dxPx = clientX - (rect.left + (projected.x * 0.5 + 0.5) * rect.width);
    const dyPx = clientY - (rect.top + (-projected.y * 0.5 + 0.5) * rect.height);
    const distance = Math.max(0.1, anchor.distanceTo(this.cam.position));
    const unitsPerPx = (2 * Math.tan(THREE.MathUtils.degToRad(this.cam.fov) * 0.5) * distance) / Math.max(1, rect.height);
    const right = new THREE.Vector3().setFromMatrixColumn(this.cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.cam.matrixWorld, 1);
    const disp = right.multiplyScalar(dxPx * unitsPerPx).add(up.multiplyScalar(-dyPx * unitsPerPx));
    return this.nudgeVibePortal({ x: disp.x, y: disp.y, z: disp.z });
  }

  resetCam(): void {
    this.yaw = 0;
    const open = this.openingProgress >= BINDER_FULLY_OPEN_PROGRESS;
    this.pitch = open ? -0.14 : -0.27;
    this.dist = open ? 4.35 : 4.75;
    this.lookTarget.copy(BINDER_LOOK_AT);
    this.pitch = THREE.MathUtils.clamp(this.pitch, BINDER_ORBIT_PITCH_MIN, BINDER_ORBIT_PITCH_MAX);
  }

  playPortalTransition(direction: "in" | "out", durationMs = 760): Promise<void> {
    this.portalTransitionDirection = direction;
    this.portalTransitionDuration = durationMs;
    this.portalTransitionUntil = performance.now() + durationMs;
    if (direction === "out") {
      this.openingTarget = 0.78;
    } else {
      this.openingTarget = 1;
    }
    return new Promise((resolve) => {
      window.setTimeout(resolve, durationMs);
    });
  }

  /**
   * OS overlays (screenshots), tab blur, or lost capture can skip `pointerup` — finish an active page drag
   * so the spring (`tgt`) runs and the leaf does not freeze mid-turn.
   */
  releaseInterruptedGesture(): void {
    if (this.codexDragActive && this.armCatalogPickIndex !== null) {
      const idxLift = this.armCatalogPickIndex;
      this.onCodexPointerDrag?.({
        phase: "cancel",
        pickIndex: idxLift,
        clientX: this.armSX,
        clientY: this.armSY,
      });
      this.codexPulledPickIndices.delete(idxLift);
    }
    this.codexDragActive = false;
    this.armCatalogPickIndex = null;
    this.orb = false;
    this.coverTapArmed = false;
    this.pendingCardTap = false;
    this.flipArm = null;
    this._clearCodexLongPressTimer();
    this._setCatalogSelection(null);
    if (this.codexHandDragMode) this._v();
    if (this.drag) this._settleActivePageDrag();
  }

  /** Doctrine picker: a recto card is mid “lift” drag toward the DOM hand (for global pointer release routing). */
  isCodexBinderPullDragActive(): boolean {
    return this.codexDragActive && this.armCatalogPickIndex !== null;
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
      this.dragAngVelSmooth = 0;
      this.dragAngVelPrevT = 0;
      return;
    }
    const thr = Math.PI * (0.4 - Math.min(0.17, pv));
    this.tgt = this.ang >= thr ? Math.PI : 0;
    let v0 = this.dragAngVelSmooth;
    if (!Number.isFinite(v0) || Math.abs(v0) < FLIP_DRAG_ANG_VEL_DEADBAND) v0 = 0;
    this.vel = THREE.MathUtils.clamp(v0 * FLIP_RELEASE_ANG_VEL_BLEND, -FLIP_MAX_ANG_VEL, FLIP_MAX_ANG_VEL);
    // #region agent log
    fetch("http://127.0.0.1:7536/ingest/bef92781-28ef-46f8-965d-ec6701871e09", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "b91e25" },
      body: JSON.stringify({
        sessionId: "b91e25",
        hypothesisId: "impulse",
        location: "CardBinderEngine.ts:_settleActivePageDrag",
        message: "release_spring_seed",
        data: { tgt: this.tgt, ang: this.ang, v0, vel: this.vel, pv },
        timestamp: Date.now(),
        runId: "impulse-transfer",
      }),
    }).catch(() => {});
    // #endregion
    this.dragAngVelSmooth = 0;
    this.dragAngVelPrevT = 0;
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

  private _stripDoctrineBadge(mesh: THREE.Mesh): void {
    const b = mesh.userData._doctrineBadge as THREE.Mesh | undefined;
    if (b) {
      mesh.remove(b);
      const mat = b.material as THREE.MeshBasicMaterial;
      mat.map?.dispose();
      mat.dispose();
      b.geometry.dispose();
      delete mesh.userData._doctrineBadge;
    }
  }

  /** Strip legacy doctrine badges / outlines on card faces (no slot overlay in picker). */
  private _stripBinderPickDecor(): void {
    this.G.traverse((ch) => {
      const mesh = ch as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh.userData.gridPick !== true) return;
      this._stripPanelOutline(mesh);
      this._stripDoctrineBadge(mesh);
    });
  }

  private _refreshBinderFaceDecor(): void {
    this._stripBinderPickDecor();
    this._applyCatalogSelectionDecor();
  }

  private _clearCodexLongPressTimer(): void {
    if (this._codexLongPressTimer !== null) {
      globalThis.clearTimeout(this._codexLongPressTimer);
      this._codexLongPressTimer = null;
    }
  }

  private _scheduleCodexLongPressIfEligible(): void {
    this._clearCodexLongPressTimer();
    if (!this.codexHandDragMode) return;
    const idx = this.armCatalogPickIndex;
    if (idx === null || idx < 0) return;
    this._codexLongPressTimer = globalThis.setTimeout(() => {
      this._codexLongPressTimer = null;
      if (this.disposed) return;
      if (!this.pendingCardTap || this.armCatalogPickIndex !== idx) return;
      if (this.codexDragActive) return;
      this._startCodexBinderPullDrag(idx);
    }, this.CODEX_LONG_PRESS_MS);
  }

  /** Long-press on a recto: sleeve shows card-back, DOM ghost drag begins. */
  private _startCodexBinderPullDrag(idx: number): void {
    this._clearCodexLongPressTimer();
    this._setCatalogSelection(idx);
    this.codexPulledPickIndices.add(idx);
    this.codexDragActive = true;
    this.pendingCardTap = false;
    this.cancelPendingCatalogPick();
    this._v();
    this.onCodexPointerDrag?.({
      phase: "start",
      pickIndex: idx,
      clientX: this.armSX,
      clientY: this.armSY,
    });
  }

  private _stripCatalogSelectRings(): void {
    this.innerGroup.traverse((ch) => {
      const mesh = ch as THREE.Mesh;
      if (!mesh.isMesh) return;
      const ring = mesh.userData._catalogSelectRing as THREE.LineLoop | undefined;
      if (!ring) return;
      mesh.remove(ring);
      ring.geometry.dispose();
      (ring.material as THREE.Material).dispose();
      delete mesh.userData._catalogSelectRing;
    });
  }

  private _applyCatalogSelectionDecor(): void {
    this._stripCatalogSelectRings();
    if (!this.codexHandDragMode) return;
    const sel = this.selectedCatalogPickIndex;
    if (sel === null) return;
    const hw = colW * 0.48;
    const hh = rowH * 0.48;
    const zOff = 0.002;
    this.innerGroup.traverse((ch) => {
      const mesh = ch as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh.userData.binderFace !== "recto") return;
      if (mesh.userData.gridPick !== true) return;
      if ((mesh.userData.pickIndex as number) !== sel) return;
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-hw, -hh, zOff),
        new THREE.Vector3(hw, -hh, zOff),
        new THREE.Vector3(hw, hh, zOff),
        new THREE.Vector3(-hw, hh, zOff),
      ]);
      const ring = new THREE.LineLoop(
        geo,
        new THREE.LineBasicMaterial({ color: 0x52d88a, toneMapped: false, depthTest: true }),
      );
      ring.renderOrder = (mesh.renderOrder ?? 0) + 30;
      mesh.add(ring);
      mesh.userData._catalogSelectRing = ring;
    });
  }

  private _setCatalogSelection(idx: number | null): void {
    if (this.selectedCatalogPickIndex === idx) {
      if (this.codexHandDragMode) this._applyCatalogSelectionDecor();
      return;
    }
    this.selectedCatalogPickIndex = idx;
    if (this.codexHandDragMode) this.onCatalogSelectionChange?.(idx);
    this._applyCatalogSelectionDecor();
  }

  /** Clears recto selection (picker: Escape / programmatic). */
  clearCodexCatalogSelection(): void {
    this._clearCodexLongPressTimer();
    this._setCatalogSelection(null);
  }

  wheelAt(clientX: number, clientY: number, rect: DOMRect, dy: number): void {
    const zoomingIn = dy < 0;
    if (zoomingIn && mayRaycastCatalog(this.getBinderUiMode())) {
      this.ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      this.ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.ndc, this.cam);
      const hits = this.raycaster.intersectObjects(this._pickablePageMeshes(), false);
      if (hits[0]) this.lookTarget.lerp(hits[0].point, 0.42);
    } else if (!zoomingIn) {
      this.lookTarget.lerp(BINDER_LOOK_AT, 0.16);
    }
    this.dist = THREE.MathUtils.clamp(this.dist * Math.exp(dy * 0.0018), 0.72, 12);
  }

  wheel(dy: number): void {
    this.dist = THREE.MathUtils.clamp(this.dist * Math.exp(dy * 0.0018), 0.72, 12);
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

  /** Clears tap-to-assign intent so `pointerup` does not assign after opening detail. */
  clearCatalogTapIntent(): void {
    this.cancelPendingCatalogPick();
    this._clearCodexLongPressTimer();
    this.pendingCardTap = false;
  }

  /**
   * After `pD` re-arms the catalog cell, call when the pointer-down was consumed by overlay UI
   * (e.g. double-tap rules card) so `armCatalogPickIndex` does not linger for the next move/up.
   */
  resetCatalogPickArmAfterUiConsume(): void {
    if (!this.codexDragActive) this.armCatalogPickIndex = null;
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
        /** Rebuild spreads once the folio is actually open — avoids the first `_v()` while `openingProgress===0` and keeps slots aligned with visibility gates. */
        if (!this.disposed) this._v();
      }
      this.onOpenStateChange?.(open);
    }
  }

  /** Same yaw offset as `_tick` camera rig — keep “rear” test aligned with what you see. */
  private _orbitYawNudge(): number {
    return THREE.MathUtils.lerp(0.09, 0, easeOutCubic(this.openingProgress));
  }

  /** Camera has orbited to the leather rear (world −Z hemisphere in this rig), not the folio front. */
  private _cameraViewingTomeRear(): boolean {
    return Math.cos(this.yaw + this._orbitYawNudge()) < -0.34;
  }

  private _applyBinderTransform(yWave = 0, scaleMult = 1): void {
    this.G.position.set(
      this.binderPlacement.x,
      BINDER_FLOAT_Y + this.binderPlacement.y + yWave,
      this.binderPlacement.z,
    );
    this.G.scale.setScalar(this.binderPlacement.scale * scaleMult);
    this._applyVibePortalTransform();
  }

  private _applyVibePortalTransform(): void {
    this.vibePortalGroup.position.set(this.vibePortalPlacement.x, this.vibePortalPlacement.y, this.vibePortalPlacement.z);
    this.vibePortalGroup.rotation.set(this.vibePortalPlacement.rx, this.vibePortalPlacement.ry, this.vibePortalPlacement.rz);
    this.vibePortalGroup.scale.setScalar(this.vibePortalPlacement.scale);
  }

  /**
   * True when LMB targets the rear leather board **from behind** — blocked if pages/shell/cover
   * are closer along the same ray (prevents the joke firing through the open folio from the front).
   */
  private _rayHitsTomeBack(clientX: number, clientY: number, rect: DOMRect): boolean {
    const mode = this.getBinderUiMode();
    if (mode === "orbit") return false;
    if (mode !== "closed" && mode !== "opening" && mode !== "open_idle" && mode !== "page_spring") return false;
    if (!this.tomeBackGroup.visible) return false;
    if (!this._cameraViewingTomeRear()) return false;
    this.ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.ndc, this.cam);
    const backHits = this.raycaster.intersectObject(this.tomeBackGroup, true);
    if (backHits.length === 0) return false;
    const backDist = backHits[0]!.distance;
    const first = backHits[0]!.object;
    let onBack = false;
    let o: THREE.Object3D | null = first;
    while (o) {
      if (o === this.tomeBackGroup) {
        onBack = true;
        break;
      }
      o = o.parent;
    }
    if (!onBack) return false;

    let nearestCloser = Infinity;
    const roots = [this.innerGroup, this.shellGroup, this.coverHinge];
    for (const root of roots) {
      if (!root.visible) continue;
      const h = this.raycaster.intersectObject(root, true);
      if (h.length > 0) nearestCloser = Math.min(nearestCloser, h[0]!.distance);
    }
    if (nearestCloser < backDist - 0.018) return false;
    return true;
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
    if (side === "right" && this.chunks.length > 1 && this.cur < this.chunks.length - 1) return "right";
    if (side === "left" && this.chunks.length > 1 && this.cur > 0) return "left";
    return null;
  }

  /**
   * Side-only outer edge bands for page turns. Doctrine mode keeps the in-page strip narrow so the
   * outer card column remains selectable, while allowing a small ray-plane zone just outside the left/right book edge.
   */
  private _edgeTurnSideFromPlane(
    clientX: number,
    clientY: number,
    rect: DOMRect,
    /** Doctrine picker: thin true freesheet strip only — wide `0.55*PW` treats most card columns as “margin” and blocks card lift. */
    doctrineNarrowMargin = false,
  ): "left" | "right" | null {
    if (!interactionMayArmPageTurn(this.getBinderUiMode())) return null;
    const PW = BINDER_CFG.pageWidth;
    const PH = BINDER_CFG.pageHeight;
    const insideStrip = doctrineNarrowMargin ? PW * 0.065 : PW * 0.18;
    const outsideStrip = PW * 0.1;
    this.ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.ndc, this.cam);
    const inv = new THREE.Matrix4().copy(this.innerGroup.matrixWorld).invert();
    const localOrigin = this.raycaster.ray.origin.clone().applyMatrix4(inv);
    const localDir = this.raycaster.ray.direction.clone().transformDirection(inv);
    if (Math.abs(localDir.z) < 0.0001) return null;
    const zPlane = this.folioPaperMesh.position.z;
    const t = (zPlane - localOrigin.z) / localDir.z;
    if (t < 0) return null;
    const local = localOrigin.add(localDir.multiplyScalar(t));
    if (Math.abs(local.y) > PH * 0.5) return null;
    if (
      local.x >= PW - insideStrip &&
      local.x <= PW + outsideStrip &&
      this.chunks.length > 1 &&
      this.cur < this.chunks.length - 1
    ) {
      return "right";
    }
    if (
      local.x <= -PW + insideStrip &&
      local.x >= -PW - outsideStrip &&
      this.chunks.length > 1 &&
      this.cur > 0
    ) {
      return "left";
    }
    return null;
  }

  /** Kept for canvas `pointerleave` — slots stay flat (no hover depth motion). */
  clearCardHover(): void {}

  pD(e: PointerEvent, rect: DOMRect): void {
    this.pageAudio.resumeFromGesture();
    this.cancelPendingCatalogPick();
    this._clearCodexLongPressTimer();
    this.pendingCardTap = false;
    this.armCatalogPickIndex = null;
    this.codexDragActive = false;

    if (this.codexHandDragMode && e.button === 1) {
      this.orb = true;
      this.oSX = e.clientX;
      this.oSY = e.clientY;
      this.oSY2 = this.yaw;
      this.oSP = this.pitch;
      return;
    }

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
      const hitTomeBackClosed = e.button === 0 && this._rayHitsTomeBack(e.clientX, e.clientY, rect);
      if (hitTomeBackClosed) {
        this.onTomeBackTap?.();
        this.coverTapArmed = false;
      } else {
        this.coverTapArmed = mode === "closed" && this._rayHitsCover(e.clientX, e.clientY, rect);
      }
      this.armSX = e.clientX;
      this.armSY = e.clientY;
      this.drag = false;
      this.dSX = e.clientX;
      this.dSA = 0;
      return;
    }

    this.flipArm = null;
    this.coverTapArmed = false;

    /** Outer-margin peel wins over a recto ray-hit (cards cover most of the folio; otherwise peels rarely arm). */
    let marginPeelSide: "left" | "right" | null = null;
    if (interactionMayArmPageTurn(mode) && !this.fl) {
      marginPeelSide =
        this.hitSpreadSide(e.clientX, e.clientY, rect) ??
        this._edgeTurnSideFromPlane(e.clientX, e.clientY, rect, this.codexHandDragMode);
    }
    if (marginPeelSide === "right" && this.cur < this.chunks.length - 1) this.flipArm = "next";
    else if (marginPeelSide === "left" && this.cur > 0) this.flipArm = "prev";

    let rectoPick: number | null = null;
    if (mayRaycastCatalog(mode) && !this.fl) {
      rectoPick = this.pickAt(e.clientX, e.clientY, rect);
    }

    if (!this.flipArm && mayRaycastCatalog(mode) && rectoPick !== null && rectoPick >= 0) {
      this.pendingCardTap = true;
      this.armCatalogPickIndex = rectoPick;
      if (this.codexHandDragMode) this._scheduleCodexLongPressIfEligible();
    }
    const hitTomeBack = e.button === 0 && this._rayHitsTomeBack(e.clientX, e.clientY, rect);
    if (hitTomeBack) this.onTomeBackTap?.();
    if (
      e.button === 0 &&
      this.getBinderUiMode() === "open_idle" &&
      !this.flipArm &&
      !this.pendingCardTap &&
      !hitTomeBack
    ) {
      this._setCatalogSelection(null);
      this.onClearDoctrineSelection?.();
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
      this.yaw = THREE.MathUtils.clamp(this.oSY2 + dx * Math.PI, -BINDER_ORBIT_YAW_MAX, BINDER_ORBIT_YAW_MAX);
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

    if (
      this.codexHandDragMode &&
      this.codexDragActive &&
      this.armCatalogPickIndex !== null &&
      !this.flipArm &&
      !this.drag &&
      !this.orb
    ) {
      this.onCodexPointerDrag?.({
        phase: "move",
        pickIndex: this.armCatalogPickIndex,
        clientX: e.clientX,
        clientY: e.clientY,
      });
      return;
    }

    const modePick = this.getBinderUiMode();
    if (
      this.codexHandDragMode &&
      this.pendingCardTap &&
      !this.codexDragActive &&
      this.armCatalogPickIndex !== null &&
      !this.flipArm &&
      !this.drag &&
      !this.orb &&
      dist >= this.CODEX_MOVE_PULL_PX &&
      interactionMayPickCatalog(modePick)
    ) {
      this._clearCodexLongPressTimer();
      this._startCodexBinderPullDrag(this.armCatalogPickIndex);
    }

    const longPressWait =
      this.codexHandDragMode &&
      this.pendingCardTap &&
      this.armCatalogPickIndex !== null &&
      !this.codexDragActive;

    if (this.pendingCardTap && dist >= this.FLIP_ARM_PX && !this.codexDragActive) {
      if (!longPressWait || dist >= this.CODEX_LONG_PRESS_SLOP_PX) {
        this.pendingCardTap = false;
        this._clearCodexLongPressTimer();
      }
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
      this.dragAngVelSmooth = 0;
      this.dragAngVelPrevAng = this.ang;
      this.dragAngVelPrevT = performance.now();
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
    let next = dragAngleShaped(raw);
    const d = next - this.ang;
    if (d > FLIP_DRAG_ANG_STEP_CAP) next = this.ang + FLIP_DRAG_ANG_STEP_CAP;
    else if (d < -FLIP_DRAG_ANG_STEP_CAP) next = this.ang - FLIP_DRAG_ANG_STEP_CAP;
    this.ang = next;
    if (this.fl !== 0) {
      const tMs = performance.now();
      if (this.dragAngVelPrevT > 0) {
        const dtMs = tMs - this.dragAngVelPrevT;
        if (dtMs > 0 && dtMs < 120) {
          const inst = (this.ang - this.dragAngVelPrevAng) / (dtMs / 1000);
          this.dragAngVelSmooth = THREE.MathUtils.lerp(this.dragAngVelSmooth, inst, 0.38);
        }
      }
      this.dragAngVelPrevAng = this.ang;
      this.dragAngVelPrevT = tMs;
    }
  }

  pU(e: PointerEvent, rect: DOMRect): void {
    this.orb = false;
    this._clearCodexLongPressTimer();

    const moved = Math.hypot(e.clientX - this.armSX, e.clientY - this.armSY);
    const mode = this.getBinderUiMode();

    // Codex lift must finalize even if a page-turn drag (`this.drag`) was armed — otherwise `pointerup` never assigns.
    if (this.codexDragActive && this.armCatalogPickIndex !== null) {
      const idxLift = this.armCatalogPickIndex;
      this.onCodexPointerDrag?.({
        phase: "end",
        pickIndex: idxLift,
        clientX: e.clientX,
        clientY: e.clientY,
      });
      this.codexPulledPickIndices.delete(idxLift);
      this.codexDragActive = false;
      this.armCatalogPickIndex = null;
      this.pendingCardTap = false;
      this.flipArm = null;
      this.drag = false;
      this._clearCodexLongPressTimer();
      this._setCatalogSelection(null);
      this._v();
      return;
    }

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
      if (this.codexHandDragMode) {
        const mayTapSelect =
          this.pendingCardTap &&
          !this.codexDragActive &&
          this.fl === 0 &&
          moved <= this.TAP_MAX_PX &&
          interactionMayPickCatalog(mode);
        if (mayTapSelect && this.armCatalogPickIndex !== null) {
          const idx = this.pickAt(e.clientX, e.clientY, rect);
          if (idx !== null && idx >= 0 && idx === this.armCatalogPickIndex) {
            this.cancelPendingCatalogPick();
            this._setCatalogSelection(idx);
          }
        }
      } else {
        const mayTapAssign =
          this.pendingCardTap &&
          !this.codexDragActive &&
          this.fl === 0 &&
          moved <= this.TAP_MAX_PX &&
          interactionMayPickCatalog(mode);
        if (mayTapAssign) {
          const idx = this.pickAt(e.clientX, e.clientY, rect);
          if (idx !== null && idx >= 0) {
            this.cancelPendingCatalogPick();
            this._pickDebounceHandle = globalThis.setTimeout(() => {
              this._pickDebounceHandle = null;
              this.onPickCatalogIndex?.(idx);
            }, 260);
          }
        }
      }
      this.pendingCardTap = false;
      this.flipArm = null;
      return;
    }

    this._settleActivePageDrag();
  }

  pickAt(clientX: number, clientY: number, rect: DOMRect): number | null {
    if (!mayRaycastCatalog(this.getBinderUiMode())) return null;
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

  pickVibePortalAction(clientX: number, clientY: number, rect: DOMRect): VibePortalAction | null {
    this.ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.ndc, this.cam);
    if (this.raycaster.intersectObject(this.G, true).length > 0) return null;
    const hits = this.raycaster.intersectObject(this.vibePortalGroup, true);
    hits.sort((a, b) => a.distance - b.distance);
    for (const hit of hits) {
      let o: THREE.Object3D | null = hit.object;
      while (o) {
        const action = o.userData.vibePortalAction as VibePortalAction | undefined;
        if (action === "enter") return action;
        if (o === this.vibePortalGroup) break;
        o = o.parent;
      }
    }
    return null;
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
    if (this.drag && this.fl !== 0) {
      const idleMs = performance.now() - this.lastMoveT;
      if (idleMs > FLIP_DRAG_ANG_VEL_IDLE_MS) {
        const g = Math.min(1, (idleMs - FLIP_DRAG_ANG_VEL_IDLE_MS) / 220);
        this.dragAngVelSmooth *= Math.exp(-dt * (4.2 + 11 * g));
      }
    }
    if (this.fl && !this.drag && this.tgt !== null) {
      let rem = dt;
      let iters = 0;
      while (rem > 1e-10 && iters < FLIP_SPRING_MAX_ITERS) {
        iters++;
        const h = Math.min(FLIP_SPRING_DT_CAP, rem);
        this.vel += (-BINDER_CFG.springStiff * (this.ang - this.tgt) - BINDER_CFG.springDamp * this.vel) * h;
        this.vel = THREE.MathUtils.clamp(this.vel, -FLIP_MAX_ANG_VEL, FLIP_MAX_ANG_VEL);
        const distTgt = Math.abs(this.ang - this.tgt);
        const landU = THREE.MathUtils.smoothstep(0, FLIP_LANDING_WINDOW_RAD, distTgt);
        const vLandCap = THREE.MathUtils.lerp(FLIP_LANDING_MAX_ANG_VEL, FLIP_MAX_ANG_VEL, landU);
        this.vel = THREE.MathUtils.clamp(this.vel, -vLandCap, vLandCap);
        let dAng = this.vel * h;
        if (Math.abs(dAng) > FLIP_MAX_DANG_PER_SUBSTEP) {
          dAng = Math.sign(dAng) * FLIP_MAX_DANG_PER_SUBSTEP;
          this.vel = dAng / h;
        }
        this.ang += dAng;
        rem -= h;
      }
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
    // #region agent log
    if (this.fp && (this.fl !== 0 || this.drag)) {
      const t = performance.now();
      if (t - this._dbgFlipLogLast >= 56) {
        this._dbgFlipLogLast = t;
        fetch("http://127.0.0.1:7536/ingest/bef92781-28ef-46f8-965d-ec6701871e09", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "b91e25" },
          body: JSON.stringify({
            sessionId: "b91e25",
            hypothesisId: "flip",
            location: "CardBinderEngine.ts:_tick",
            message: "flip_motion_sample",
            data: {
              cur: this.cur,
              fl: this.fl,
              drag: this.drag,
              ang: this.ang,
              vel: this.vel,
              tgt: this.tgt,
              dt,
              distTgt: this.tgt !== null ? Math.abs(this.tgt - this.ang) : null,
            },
            timestamp: Date.now(),
            runId: "binder-retest",
          }),
        }).catch(() => {});
      }
    }
    // #endregion
    if (this.fp) this._aa(this.ang);
    this._tickPortal(performance.now());
    this.yaw = THREE.MathUtils.clamp(this.yaw, -BINDER_ORBIT_YAW_MAX, BINDER_ORBIT_YAW_MAX);
    this.pitch = THREE.MathUtils.clamp(this.pitch, BINDER_ORBIT_PITCH_MIN, BINDER_ORBIT_PITCH_MAX);
    this.G.rotation.y = this.yaw;
    const flipping = this.fl !== 0 && this.fp !== null;
    const tCam = easeOutCubic(this.openingProgress);
    let distBlend = THREE.MathUtils.lerp(4.75, this.dist, tCam);
    if (flipping) distBlend *= 1 + 0.016 * Math.sin(this.ang);
    const pitchBlend = THREE.MathUtils.lerp(-0.28, this.pitch, tCam);
    const yawNudge = THREE.MathUtils.lerp(0.09, 0, tCam);
    this.cam.position.set(
      this.lookTarget.x + distBlend * Math.cos(pitchBlend) * Math.sin(this.yaw + yawNudge),
      this.lookTarget.y + distBlend * Math.sin(pitchBlend) + 0.2,
      this.lookTarget.z + distBlend * Math.cos(pitchBlend) * Math.cos(this.yaw + yawNudge),
    );
    this.cam.lookAt(this.lookTarget);
    if (this.doctrineSkyboxMesh) this.doctrineSkyboxMesh.position.copy(this.cam.position);
    this.R.render(this.S, this.cam);
    if (!this.disposed) requestAnimationFrame(this._tick);
  }

  private _tickPortal(now: number): void {
    let k = 0.2 + 0.12 * Math.sin(now * 0.0025);
    if (this.portalTransitionUntil > now && this.portalTransitionDuration > 0) {
      const p = 1 - (this.portalTransitionUntil - now) / this.portalTransitionDuration;
      const wave = Math.sin(Math.max(0, Math.min(1, p)) * Math.PI);
      k += 1.3 * wave;
      if (this.portalTransitionDirection === "out") {
        this._applyBinderTransform(-0.16 * wave, 1 - 0.035 * wave);
      } else {
        this._applyBinderTransform(0.08 * wave, 1 + 0.025 * wave);
      }
    } else {
      this._applyBinderTransform();
      this.portalTransitionDirection = null;
    }
    for (const mesh of this.portalPulseMeshes) {
      const mat = mesh.material as THREE.Material & { opacity?: number; color?: THREE.Color };
      if (typeof mat.opacity === "number") mat.opacity = Math.min(0.82, 0.12 + k * 0.18);
      mesh.scale.setScalar(1 + k * 0.045);
    }
  }

  private _disposeObject(root: THREE.Object3D): void {
    root.traverse((ch) => {
      const mesh = ch as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry?.dispose();
      const mat = mesh.material;
      const disposeMat = (m: THREE.Material): void => {
        const maybeMap = (m as THREE.Material & { map?: THREE.Texture | null }).map;
        maybeMap?.dispose();
        m.dispose();
      };
      if (Array.isArray(mat)) mat.forEach(disposeMat);
      else if (mat) disposeMat(mat as THREE.Material);
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.doctrineSkyboxTexture) {
      this.doctrineSkyboxTexture.dispose();
      this.doctrineSkyboxTexture = null;
    }
    if (this.doctrineSkyboxMesh) {
      this.S.remove(this.doctrineSkyboxMesh);
      this.doctrineSkyboxMesh.geometry.dispose();
      this.doctrineSkyboxMesh.material.dispose();
      this.doctrineSkyboxMesh = null;
    }
    this.S.background = new THREE.Color(BINDER_CFG.bg);
    this.cancelPendingCatalogPick();
    this._clearCodexLongPressTimer();
    this.codexPulledPickIndices.clear();
    this._disposeObject(this.roomGroup);
    this.S.remove(this.roomGroup);
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
      if (mat.map === this._sharedLeatherTex || mat.map === this._tomeRearFaceTex) mat.map = null;
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
    this._tomeRearFaceTex.dispose();
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
