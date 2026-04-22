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
import { createGrimoireCoverTexture } from "./binderTomeArt";

/** Binder layout + flip physics (ported from CardBinder.jsx). */
export const BINDER_CFG = {
  pageWidth: 2.1,
  pageHeight: 2.85,
  seamGap: 0.04,
  seamFlex: 0.18,
  rowDroop: 0.06,
  springStiff: 80,
  springDamp: 12,
  panelTexW: 400,
  /** Scene clear color — matches standalone `CardBinder.html`. */
  bg: 0x0a0a0f,
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
export const BINDER_CODEX_SPREAD_COUNT = 10;

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

/** Sleeve planes sit slightly in front of leather (CardBinder.html `view()` / `staticPage`). */
const PAGE_SURFACE_Z = -0.005;
/**
 * Page flip hinge: `fp` rotates about **world Y** through origin. Layout places the gutter near **x = 0**
 * (`_cellLocalX`); tweak `fp.position.x` only if shell art and rings need alignment.
 */
const FLIP_LEAF_HINGE_X = 0;
const FLIP_LEAF_Z_EPS = 0.012;
const UNDER_PAGE_Z_LIFT = 0.004;
/** Two thin faces per flip cell — avoids `gl_FrontFacing` swapping recto/verso while the leaf rotates. */
const FLIP_FACE_SEP = 0.0022;
/** Phase C: recto lift toward camera (local +Z) for hover / active doctrine card. */
/** Baseline lift so recto sleeves clear the page / deck in the depth buffer (hover adds on top). */
const CARD_FLOAT_BASE_Z = 0.024;
const CARD_FLOAT_HOVER_Z = 0.036;
const CARD_FLOAT_SELECT_Z = 0.054;
const CARD_FLOAT_LAMBDA = 14;
const CARD_EDGE_DEPTH = 0.014;

const PANEL_VS = `varying vec2 vUv;varying vec3 vN;varying vec3 vP;void main(){vUv=uv;vec4 w=modelMatrix*vec4(position,1.0);vP=w.xyz;vN=normalize(mat3(modelMatrix)*normal);gl_Position=projectionMatrix*viewMatrix*w;}`;
/** Slight edge falloff + warm paper cast (keeps faces legible; does not affect flip geometry). */
const PANEL_SINGLE_FS = `precision highp float;uniform sampler2D uM;uniform vec3 uL;uniform float uFlipU;uniform float uFlipV;varying vec2 vUv;varying vec3 vN;varying vec3 vP;void main(){vec2 uv=vec2(mix(vUv.x,1.0-vUv.x,uFlipU),mix(vUv.y,1.0-vUv.y,uFlipV));vec3 V=normalize(cameraPosition-vP);vec3 N=normalize(vN);vec4 base=texture2D(uM,uv);vec3 L=normalize(uL);vec3 Hn=normalize(L+V);float diff=max(dot(N,L),0.0)*0.28+0.78;float spec=pow(max(dot(N,Hn),0.0),72.0)*0.45;float fres=pow(1.0-max(dot(N,V),0.0),3.0)*0.06;float vig=mix(0.93,1.0,smoothstep(0.78,0.2,length(vUv-vec2(0.5))*1.14));vec3 col=base.rgb*diff+spec+vec3(0.55,0.62,1.0)*fres;col*=vig;col=mix(col,col*vec3(1.02,1.01,0.985),0.07);gl_FragColor=vec4(col,base.a);}`;

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
  private readonly _cardEdgeGeo: THREE.BoxGeometry;
  private readonly _cardEdgeMat: THREE.MeshStandardMaterial;
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
  private readonly _panelLightDir = new THREE.Vector3(1, 3, 4).normalize();
  /** 0 = closed tome, 1 = fully open binder; animated toward `openingTarget`. */
  private openingProgress = 0;
  private openingTarget: number | null = null;
  private coverTapArmed = false;
  private _lastNotifiedOpen = false;
  private readonly marginHitGroup = new THREE.Group();
  private _marginMat: THREE.MeshBasicMaterial | null = null;
  private _pickDebounceHandle: ReturnType<typeof globalThis.setTimeout> | null = null;
  /** Catalog panel index under cursor (open binder, idle). */
  private hoverCatalogIndex: number | null = null;

  constructor(canvas: HTMLCanvasElement, textures: THREE.Texture[], _opts?: CardBinderEngineOptions) {
    this.R = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.R.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.R.outputColorSpace = THREE.SRGBColorSpace;
    this.R.toneMapping = THREE.ACESFilmicToneMapping;
    this.R.toneMappingExposure = 1.72;

    this.S = new THREE.Scene();
    this.S.background = new THREE.Color(BINDER_CFG.bg);
    this.cam = new THREE.PerspectiveCamera(40, 1, 0.1, 100);

    const addLight = (L: THREE.Light): void => {
      this.S.add(L);
      this._ownedLights.push(L);
    };

    addLight(new THREE.AmbientLight(0xffffff, 0.52));
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
    const spine = new THREE.PointLight(0xffecd8, 0.22, 9);
    spine.position.set(-2.35, 0.15, 1.05);
    addLight(spine);

    this.G = new THREE.Group();
    this.S.add(this.G);

    this._sharedLeatherTex = createProceduralLeatherTexture();

    this.tomeBackGroup.name = "binder_tome_back";
    this.G.add(this.tomeBackGroup);
    this._addTomeBackPlate(this.tomeBackGroup, this._sharedLeatherTex);

    this.shellGroup = new THREE.Group();
    this.shellGroup.name = "binder_ring_shell";
    this.G.add(this.shellGroup);
    this.ringMechanismGroup.name = "binder_three_ring_mechanism";
    this.shellGroup.add(this.ringMechanismGroup);
    this._addRingBinderMechanism(this.shellGroup, this.ringMechanismGroup, this._sharedLeatherTex);

    this.innerGroup = new THREE.Group();
    this.innerGroup.name = "binder_inner_pages";
    this.G.add(this.innerGroup);

    this.marginHitGroup.name = "binder_margin_hits";
    this.innerGroup.add(this.marginHitGroup);

    this.coverHinge.name = "binder_front_cover_hinge";
    this.G.add(this.coverHinge);
    this._addFrontCover(this.coverHinge, this._sharedLeatherTex);

    this.pg = new THREE.PlaneGeometry(colW, rowH);
    this._cardEdgeGeo = new THREE.BoxGeometry(colW * 0.96, rowH * 0.96, CARD_EDGE_DEPTH);
    this._cardEdgeMat = new THREE.MeshStandardMaterial({
      color: 0x24180e,
      roughness: 0.62,
      metalness: 0.08,
    });
    this._cardEdgeMat.polygonOffset = true;
    this._cardEdgeMat.polygonOffsetFactor = 2;
    this._cardEdgeMat.polygonOffsetUnits = 1;
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
    if (!this._chunkHasCards(toward)) return null;
    return { toward, paired: [...this.chunks[chunkIdx]!] };
  }

  private _matSingleFace(
    map: THREE.Texture,
    opts?: { flipU?: boolean; flipV?: boolean },
  ): THREE.ShaderMaterial {
    const m = new THREE.ShaderMaterial({
      uniforms: {
        uM: { value: map },
        uL: { value: this._panelLightDir },
        uFlipU: { value: opts?.flipU ? 1 : 0 },
        uFlipV: { value: opts?.flipV ? 1 : 0 },
      },
      vertexShader: PANEL_VS,
      fragmentShader: PANEL_SINGLE_FS,
      side: THREE.FrontSide,
    });
    // Avoid polygon offset here: it pushes sleeves behind coplanar leather in the depth buffer so
    // faces read as solid black until hover lifts the card group toward the camera.
    return m;
  }

  /** Rear board + spine — the “outer” tome you feel behind the folio. */
  private _addTomeBackPlate(parent: THREE.Group, leatherMap: THREE.CanvasTexture): void {
    const PH = BINDER_CFG.pageHeight;
    const PW = BINDER_CFG.pageWidth;
    const leather = new THREE.MeshStandardMaterial({
      map: leatherMap,
      roughness: 0.9,
      metalness: 0.04,
    });
    this._shellMaterials.push(leather);

    const spreadW = PW * 2 + 0.44;
    const spreadH = PH + 0.34;
    const backDepth = 0.12;
    const back = new THREE.Mesh(new THREE.BoxGeometry(spreadW, spreadH, backDepth), leather);
    back.position.set(0, 0, -0.132);
    parent.add(back);

    const spine = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, spreadH + 0.04, backDepth + 0.08),
      leather,
    );
    spine.position.set(-PW - 0.08, 0, -0.075);
    parent.add(spine);

    const paper = new THREE.MeshStandardMaterial({ color: 0xeae4d8, roughness: 0.94, metalness: 0 });
    this._shellMaterials.push(paper);
    const pageBlock = new THREE.Mesh(new THREE.BoxGeometry(0.06, spreadH * 0.9, 0.035), paper);
    pageBlock.position.set(-PW + 0.03, 0, -0.055);
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
    ribbon.position.set(-PW - 0.05, PH * 0.06, 0.035);
    ribbon.rotation.set(0.05, -0.12, 0.08);
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
        riv.position.set(sx * (PW + 0.05), sy * (PH / 2 + 0.06), 0.012);
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

    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.09, PH * 0.9, 0.042), metal);
    rail.position.set(-PW - 0.03, 0, 0.008);
    ringRoot.add(rail);

    const postX = -PW - 0.03;
    const ringZ = 0.042;
    const ringYs = [-PH * 0.34, 0, PH * 0.34];
    for (const y of ringYs) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.078, 0.016, 16, 40), metal);
      ring.position.set(postX + 0.02, y, ringZ);
      ring.rotation.y = Math.PI / 2;
      ringRoot.add(ring);

      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.09, 12), metal);
      post.position.set(postX - 0.02, y, -0.015);
      post.rotation.z = Math.PI / 2;
      ringRoot.add(post);

      const clasp = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.034, 0.018), metal);
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
    for (let r = 0; r < BINDER_ROWS; r++) {
      for (let c = 0; c < BINDER_COLS; c++) {
        const k = CardBinderEngine._cellIndex(r, c);
        const ti = toward[k]!;
        const pi = paired[k]!;
        const frontT = this._gT(ti);
        const backT = pi >= 0 ? this._gT(pi) : this.cardBackTex;
        const cell = this._binderCellPair(frontT, backT, ti, kind, meshRenderOrder, pi >= 0 ? pi : undefined);
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

  private _binderCellPair(
    frontTex: THREE.Texture,
    backTex: THREE.Texture,
    rectoPickIndex: number,
    _kind: "static" | "flip",
    meshRenderOrder: number,
    versoPickIndex?: number,
  ): THREE.Group {
    const cell = new THREE.Group();
    const hz = FLIP_FACE_SEP * 0.5;
    const front = new THREE.Mesh(this.pg, this._matSingleFace(frontTex));
    front.position.z = hz;
    front.renderOrder = meshRenderOrder;
    front.userData.pickIndex = rectoPickIndex;
    front.userData.gridPick = rectoPickIndex >= 0;
    front.userData.binderFace = "recto" as const;
    front.userData.binderRole = "sleeve_recto" as const;
    if (rectoPickIndex >= 0) front.userData.catalogIndex = rectoPickIndex;

    const back = new THREE.Mesh(this.pg, this._matSingleFace(backTex, { flipV: true }));
    back.position.z = -hz;
    back.rotation.x = Math.PI;
    back.renderOrder = meshRenderOrder;
    back.userData.binderFace = "verso" as const;
    back.userData.binderRole = "sleeve_verso" as const;
    if (versoPickIndex !== undefined && versoPickIndex >= 0) {
      back.userData.pickIndex = versoPickIndex;
      back.userData.catalogIndex = versoPickIndex;
    }

    if (rectoPickIndex >= 0) {
      const cardFloat = new THREE.Group();
      cardFloat.name = "binder_card_float";
      cardFloat.userData.catalogPickIndex = rectoPickIndex;
      cardFloat.position.z = CARD_FLOAT_BASE_Z;

      const edgeGeo = this._cardEdgeGeo.clone();
      const edge = new THREE.Mesh(edgeGeo, this._cardEdgeMat);
      edge.userData.skipMaterialDispose = true;
      edge.userData.ownsGeometry = true;
      edge.position.z = hz - CARD_EDGE_DEPTH * 0.35;
      edge.renderOrder = meshRenderOrder;
      cardFloat.add(edge);

      front.position.z = hz + 0.004;
      cardFloat.add(front);
      cell.add(cardFloat);
    } else {
      front.position.z = hz;
      cell.add(front);
    }

    cell.add(back);
    return cell;
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
      this.innerGroup.add(this.lp);
    } else if (s === 0) {
      /** First spread: `_leftSpread(0)` is null — still draw the left leaf so both halves read as a folio. */
      this.lp = this._sp(this._emptyChunk(), this._emptyChunk(), -1);
      this.lp.position.z = PAGE_SURFACE_Z;
      this.innerGroup.add(this.lp);
    }
    if (this.chunks[s]) {
      this.rp = this._sp(this.chunks[s]!, this._pairedVersoRight(s), 1);
      this.rp.position.z = PAGE_SURFACE_Z;
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
      this.fp = this._pageSheet(this.chunks[s - 1]!, this.chunks[s]!, -1, "flip", 5);
      this.fp.position.set(FLIP_LEAF_HINGE_X, 0, PAGE_SURFACE_Z + FLIP_LEAF_Z_EPS);
      this.innerGroup.add(this.fp);
      this._cl(this.lp);
      this.lp = null;
      const uc = s >= 2 ? s - 2 : null;
      if (uc !== null && this._chunkHasCards(this.chunks[uc]!)) {
        this.lp = this._sp(this.chunks[uc]!, this._pairedVersoRight(uc), -1, 1);
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
  }

  private _done(): void {
    if (this.fl === 1) this.cur++;
    else if (this.fl === -1) this.cur--;
    this.fl = 0;
    this.ang = 0;
    this.vel = 0;
    this.tgt = null;
    this._v();
  }

  private _canc(): void {
    this.fl = 0;
    this.ang = 0;
    this.vel = 0;
    this.tgt = null;
    this._v();
  }

  private _notifyPage(): void {
    this.onPageChange?.(this.cur, Math.max(1, this.chunks.length));
  }

  flipNext(): void {
    if (this.openingProgress < BINDER_FULLY_OPEN_PROGRESS || this.fl || this.cur >= this.chunks.length - 1)
      return;
    this.cancelPendingCatalogPick();
    this.fl = 1;
    this.ang = 0;
    this.vel = 0;
    this.tgt = Math.PI;
    this._sf();
  }

  flipPrev(): void {
    if (this.openingProgress < BINDER_FULLY_OPEN_PROGRESS || this.fl || this.cur <= 0) return;
    this.cancelPendingCatalogPick();
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
      });
      const lines = new THREE.LineLoop(g, mat);
      lines.position.z = 0.018;
      lines.renderOrder = 10;
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

  /** Invisible gutter-adjacent planes for page-turn drag (replaces NDC fraction fallback). */
  private _syncMarginHits(): void {
    if (!this._marginMat) {
      this._marginMat = new THREE.MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
    }
    for (const ch of [...this.marginHitGroup.children]) {
      const m = ch as THREE.Mesh;
      this.marginHitGroup.remove(m);
      m.geometry.dispose();
    }
    if (this.openingProgress < BINDER_FULLY_OPEN_PROGRESS) return;

    const spineHalf = 0.07;
    const PW = BINDER_CFG.pageWidth;
    const PH = BINDER_CFG.pageHeight;
    const z = PAGE_SURFACE_Z + 0.028;
    const w = Math.max(0.22, PW * 0.54 - spineHalf);
    const h = PH * 0.9;

    if (this.cur < this.chunks.length - 1) {
      const geo = new THREE.PlaneGeometry(w, h);
      const mesh = new THREE.Mesh(geo, this._marginMat);
      mesh.position.set(spineHalf + w / 2, 0, z);
      mesh.userData.binderRole = "page_margin";
      mesh.userData.marginSide = "right";
      this.marginHitGroup.add(mesh);
    }
    if (this.cur > 0) {
      const geo = new THREE.PlaneGeometry(w, h);
      const mesh = new THREE.Mesh(geo, this._marginMat);
      mesh.position.set(-(spineHalf + w / 2), 0, z);
      mesh.userData.binderRole = "page_margin";
      mesh.userData.marginSide = "left";
      this.marginHitGroup.add(mesh);
    }
  }

  private _applyBinderOpenness(): void {
    const te = easeOutCubic(this.openingProgress);
    this.coverHinge.rotation.y = te * (-1.24 * Math.PI);
    this.innerGroup.visible = this.openingProgress > 0.09;
    this.coverHinge.visible = this.openingProgress < 0.992;
    const mechTe = THREE.MathUtils.smoothstep(this.openingProgress, 0.04, 0.24);
    this.shellGroup.visible = this.openingProgress > 0.035;
    this.shellGroup.position.z = THREE.MathUtils.lerp(-0.036, 0.014, te);
    this.ringMechanismGroup.scale.setScalar(0.78 + 0.22 * mechTe);
    this.tomeBackGroup.position.z = THREE.MathUtils.lerp(0, 0.012, te);
    const open = this.openingProgress >= BINDER_FULLY_OPEN_PROGRESS;
    if (open !== this._lastNotifiedOpen) {
      this._lastNotifiedOpen = open;
      this.onOpenStateChange?.(open);
      if (open) this._syncMarginHits();
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
    if (side === "right" && this.cur < this.chunks.length - 1) return "right";
    if (side === "left" && this.cur > 0) return "left";
    return null;
  }

  /**
   * Outer horizontal bands on the folio plane — arms page turns before card picks (doctrine UX).
   * Uses the sleeve plane z, not margin quads (those sit in front of cards in ray order).
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
    if (hit.x >= edge && this.cur < this.chunks.length - 1) return "right";
    if (hit.x <= -edge && this.cur > 0) return "left";
    return null;
  }

  /** Clear hover lift targets (e.g. pointer left canvas). */
  clearCardHover(): void {
    this.hoverCatalogIndex = null;
  }

  private _refreshHoverCatalog(clientX: number, clientY: number, rect: DOMRect): void {
    if (
      this.getBinderUiMode() !== "open_idle" ||
      this.fl !== 0 ||
      this.openingProgress < BINDER_FULLY_OPEN_PROGRESS
    ) {
      this.hoverCatalogIndex = null;
      return;
    }
    const idx = this.pickAt(clientX, clientY, rect);
    this.hoverCatalogIndex = idx !== null && idx >= 0 ? idx : null;
  }

  private _updateCardFloatMotion(dt: number): void {
    if (this.openingProgress < BINDER_FULLY_OPEN_PROGRESS) return;

    const order = this.doctrOrder;
    const slots = this.doctrSlots;
    const slotId =
      this.doctrActive !== null && this.doctrActive >= 0 && this.doctrActive < slots.length
        ? slots[this.doctrActive]!
        : null;

    const k = Math.min(1, CARD_FLOAT_LAMBDA * dt);
    this.innerGroup.traverse((ch) => {
      const o = ch as THREE.Group;
      if (o.name !== "binder_card_float") return;
      const ix = o.userData.catalogPickIndex as number;
      if (typeof ix !== "number" || ix < 0) return;

      const cid = ix < order.length ? order[ix]! : null;
      const hoverZ = this.hoverCatalogIndex === ix ? CARD_FLOAT_HOVER_Z : 0;
      const selectZ = slotId && cid && cid === slotId ? CARD_FLOAT_SELECT_Z : 0;
      const targetZ = CARD_FLOAT_BASE_Z + Math.max(hoverZ, selectZ);

      o.position.z = THREE.MathUtils.lerp(o.position.z, targetZ, k);
    });
  }

  pD(e: PointerEvent, rect: DOMRect): void {
    this.cancelPendingCatalogPick();
    this.pendingCardTap = false;

    if (e.button === 2 || e.shiftKey) {
      this.hoverCatalogIndex = null;
      this.orb = true;
      this.oSX = e.clientX;
      this.oSY = e.clientY;
      this.oSY2 = this.yaw;
      this.oSP = this.pitch;
      return;
    }

    const mode = this.getBinderUiMode();
    if (mode === "closed" || mode === "opening") {
      this.hoverCatalogIndex = null;
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
      this.yaw = this.oSY2 + dx * Math.PI;
      this.pitch = Math.max(-1, Math.min(1, this.oSP + dy * Math.PI * 0.6));
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
    }

    if (!this.drag) {
      this._refreshHoverCatalog(e.clientX, e.clientY, rect);
      return;
    }

    this.hoverCatalogIndex = null;
    const drag = ((e.clientX - this.dSX) / rect.width) * Math.PI * 1.5;
    this.ang = Math.max(0, Math.min(Math.PI, this.dSA - drag));
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

    this.drag = false;
    this.tgt = this.ang > Math.PI * 0.4 ? Math.PI : 0;
    this.flipArm = null;
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
        if (Math.abs(this.vel) < 0.3) this._done();
      } else if (
        (this.fl === 1 && this.tgt === 0 && this.ang <= 0.01) ||
        (this.fl === -1 && this.tgt === 0 && this.ang <= 0.01)
      ) {
        if (Math.abs(this.vel) < 0.3) this._canc();
      }
    }
    if (this.fp) this._aa(this.ang);
    this._updateCardFloatMotion(dt);
    const tCam = easeOutCubic(this.openingProgress);
    const distBlend = THREE.MathUtils.lerp(4.88, this.dist, tCam);
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

    this.G.remove(this.innerGroup);
    this._sharedLeatherTex.dispose();
    this._cardEdgeGeo.dispose();
    this._cardEdgeMat.dispose();
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
  }

  get pageIndex(): number {
    return this.cur;
  }

  get pageCount(): number {
    return Math.max(1, this.chunks.length);
  }
}

export type { BinderUiMode } from "./binderInteractionState";
