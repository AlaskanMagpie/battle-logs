import * as THREE from "three";
import { DOCTRINE_SLOT_COUNT } from "../../game/constants";
import { TCG_FULL_CARD_H, TCG_FULL_CARD_W } from "../tcgCardPrint";
import { createBinderCardBackTexture } from "./binderCardBackTexture";
import { composeCardIntoBinderSleeve } from "./binderSleeveComposite";

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
const FLIP_LEAF_Z_EPS = 0.012;
const UNDER_PAGE_Z_LIFT = 0.004;
/** Two thin faces per flip cell — avoids `gl_FrontFacing` swapping recto/verso while the leaf rotates. */
const FLIP_FACE_SEP = 0.0022;

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

export class CardBinderEngine {
  readonly R: THREE.WebGLRenderer;
  readonly S: THREE.Scene;
  readonly cam: THREE.PerspectiveCamera;
  readonly G: THREE.Group;
  private readonly shellGroup: THREE.Group;
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

  private flipArm: "next" | "prev" | null = null;
  private armSX = 0;
  private armSY = 0;
  private readonly FLIP_ARM_PX = 10;
  private readonly TAP_MAX_PX = 14;
  private readonly _panelLightDir = new THREE.Vector3(1, 3, 4).normalize();

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

    this.shellGroup = new THREE.Group();
    this.shellGroup.name = "binder_cardbinder_shell";
    this.G.add(this.shellGroup);
    this._addCardBinderHtmlShell(this.shellGroup);

    this.pg = new THREE.PlaneGeometry(colW, rowH);
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
    return new THREE.ShaderMaterial({
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
  }

  private _addCardBinderHtmlShell(parent: THREE.Group): void {
    const PH = BINDER_CFG.pageHeight;
    const sm = new THREE.MeshStandardMaterial({ color: 0x1a1a24, roughness: 0.7, metalness: 0.1 });
    const sp = new THREE.Mesh(new THREE.BoxGeometry(0.08, PH + 0.3, 0.12), sm);
    sp.position.set(0, 0, -0.02);
    parent.add(sp);
    this._shellMaterials.push(sm);

    const rm = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.3, metalness: 0.8 });
    this._shellMaterials.push(rm);
    const ringYs = [-1.05, -0.52, 0, 0.52, 1.05];
    for (const y of ringYs) {
      const rn = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.01, 12, 24), rm);
      rn.position.set(0, y, 0.02);
      rn.rotation.y = Math.PI / 2;
      parent.add(rn);
    }

    const mkLeather = (): THREE.CanvasTexture => {
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
    };
    const leatherMap = mkLeather();
    const lM = new THREE.MeshStandardMaterial({ map: leatherMap, roughness: 0.85, metalness: 0.05 });
    const gM = new THREE.MeshStandardMaterial({ color: 0xd9b47a, roughness: 0.3, metalness: 0.9 });
    gM.emissive = new THREE.Color(0x2a1810);
    gM.emissiveIntensity = 0.14;
    this._shellMaterials.push(lM, gM);

    const PW = BINDER_CFG.pageWidth;
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number): void => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      parent.add(m);
    };
    add(new THREE.BoxGeometry(PW * 2 + 0.34, PH + 0.22, 0.07), lM, 0, 0, -0.05);
    add(new THREE.BoxGeometry(0.14, PH + 0.22, 0.18), lM, 0, 0, -0.06);
    for (const i of [-1, 1]) add(new THREE.BoxGeometry(0.15, 0.05, 0.19), gM, 0, i * 0.7, -0.06);
    for (const s of [-1, 1]) {
      add(new THREE.BoxGeometry(0.08, PH + 0.22, 0.06), lM, s * (PW + 0.04), 0, -0.01);
      add(new THREE.BoxGeometry(PW * 2 + 0.34, 0.08, 0.06), lM, 0, s * (PH / 2 + 0.04), -0.01);
    }
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        add(new THREE.BoxGeometry(0.18, 0.18, 0.025), gM, sx * (PW + 0.04), sy * (PH / 2 + 0.04), 0.02);
      }
    }

    const ribM = new THREE.MeshStandardMaterial({
      color: 0x4a1424,
      roughness: 0.42,
      metalness: 0.15,
      emissive: new THREE.Color(0x120406),
      emissiveIntensity: 0.22,
    });
    this._shellMaterials.push(ribM);
    const ribbon = new THREE.Mesh(new THREE.BoxGeometry(0.034, PH * 0.52, 0.014), ribM);
    ribbon.position.set(0.11, PH * 0.04, 0.048);
    ribbon.rotation.set(0.06, 0.05, 0.04);
    ribbon.renderOrder = -3;
    parent.add(ribbon);
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
  ): THREE.Group {
    const g = new THREE.Group();
    for (let r = 0; r < BINDER_ROWS; r++) {
      for (let c = 0; c < BINDER_COLS; c++) {
        const k = CardBinderEngine._cellIndex(r, c);
        const ti = toward[k]!;
        const pi = paired[k]!;
        const frontT = this._gT(ti);
        const backT = pi >= 0 ? this._gT(pi) : this.cardBackTex;
        const cell = this._binderCellPair(frontT, backT, ti, kind, pi >= 0 ? pi : undefined);
        cell.position.set(this._cellLocalX(c, side), this._rY(r), 0);
        cell.userData.gridRow = r;
        cell.userData.gridCol = c;
        cell.userData.cellIndex = k;
        g.add(cell);
      }
    }
    return g;
  }

  private _sp(toward: number[], paired: number[], side: number): THREE.Group {
    const s = side > 0 ? 1 : -1;
    return this._pageSheet(toward, paired, s, "static");
  }

  private _binderCellPair(
    frontTex: THREE.Texture,
    backTex: THREE.Texture,
    rectoPickIndex: number,
    kind: "static" | "flip",
    versoPickIndex?: number,
  ): THREE.Group {
    const cell = new THREE.Group();
    const hz = FLIP_FACE_SEP * 0.5;
    const front = new THREE.Mesh(this.pg, this._matSingleFace(frontTex));
    front.position.z = hz;
    front.renderOrder = kind === "flip" ? 4 : 3;
    front.userData.pickIndex = rectoPickIndex;
    front.userData.gridPick = rectoPickIndex >= 0;

    const back = new THREE.Mesh(this.pg, this._matSingleFace(backTex, { flipV: true }));
    back.position.z = -hz;
    back.rotation.x = Math.PI;
    back.renderOrder = kind === "flip" ? 4 : 3;
    if (versoPickIndex !== undefined && versoPickIndex >= 0) {
      back.userData.pickIndex = versoPickIndex;
    }

    cell.add(front, back);
    return cell;
  }

  private _cl(p: THREE.Group | null): void {
    if (!p) return;
    this.G.remove(p);
    p.traverse((ch) => {
      const o = ch as THREE.Mesh;
      if (o.isMesh && o.userData._outline) this._stripPanelOutline(o);
      if (o.isMesh && o.material) {
        (o.material as THREE.Material).dispose();
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
      this.G.add(this.lp);
    }
    if (this.chunks[s]) {
      this.rp = this._sp(this.chunks[s]!, this._pairedVersoRight(s), 1);
      this.rp.position.z = PAGE_SURFACE_Z;
      this.G.add(this.rp);
    }
    this._notifyPage();
    this._applyPanelHighlights();
  }

  private _sf(): void {
    this._cl(this.fp);
    this.fp = null;
    const s = this.cur;
    if (this.fl === 1 && this.chunks[s]) {
      this.fp = this._pageSheet(this.chunks[s]!, this._pairedVersoRight(s), 1, "flip");
      this.fp.position.z = PAGE_SURFACE_Z + FLIP_LEAF_Z_EPS;
      this.G.add(this.fp);
      this._cl(this.rp);
      this.rp = null;
      if (this.chunks[s + 1]) {
        const nx = s + 1;
        this.rp = this._sp(this.chunks[nx]!, this._pairedVersoRight(nx), 1);
        this.rp.position.z = PAGE_SURFACE_Z - UNDER_PAGE_Z_LIFT;
        this.G.add(this.rp);
      }
      this._applyPanelHighlights();
    }
    if (this.fl === -1 && this.chunks[s - 1]) {
      this.fp = this._pageSheet(this.chunks[s - 1]!, this.chunks[s]!, -1, "flip");
      this.fp.position.z = PAGE_SURFACE_Z + FLIP_LEAF_Z_EPS;
      this.G.add(this.fp);
      this._cl(this.lp);
      this.lp = null;
      const uc = s >= 2 ? s - 2 : null;
      if (uc !== null && this._chunkHasCards(this.chunks[uc]!)) {
        this.lp = this._sp(this.chunks[uc]!, this._pairedVersoRight(uc), -1);
        this.lp.position.z = PAGE_SURFACE_Z - UNDER_PAGE_Z_LIFT;
        this.G.add(this.lp);
      }
      this._applyPanelHighlights();
    }
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
    if (this.fl || this.cur >= this.chunks.length - 1) return;
    this.fl = 1;
    this.ang = 0;
    this.vel = 0;
    this.tgt = Math.PI;
    this._sf();
  }

  flipPrev(): void {
    if (this.fl || this.cur <= 0) return;
    this.fl = -1;
    this.ang = 0;
    this.vel = 0;
    this.tgt = Math.PI;
    this._sf();
  }

  /** Jump without animation (only when idle). Does not replace drag-to-turn. */
  jumpToFirstSpread(): void {
    if (this.fl !== 0) return;
    if (this.cur === 0) return;
    this.cur = 0;
    this._v();
  }

  /** Jump without animation (only when idle). */
  jumpToLastSpread(): void {
    if (this.fl !== 0) return;
    const last = Math.max(0, this.chunks.length - 1);
    if (this.cur === last) return;
    this.cur = last;
    this._v();
  }

  setTextures(incoming: THREE.Texture[]): void {
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
    this.pitch = -0.15;
    this.dist = 5.8;
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

  private hitSpreadSide(clientX: number, clientY: number, rect: DOMRect): "left" | "right" | null {
    this.ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.ndc, this.cam);
    const objs: THREE.Object3D[] = [];
    this.G.traverse((ch) => {
      const m = ch as THREE.Mesh;
      if (m.isMesh && typeof m.userData.pickIndex === "number") objs.push(m);
    });
    const hits = this.raycaster.intersectObjects(objs, false);
    if (hits.length > 0) {
      const p = hits[0]!.point.clone();
      this.G.worldToLocal(p);
      const spineHalf = 0.07;
      if (p.x > spineHalf) return "right";
      if (p.x < -spineHalf) return "left";
    }
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    if (nx > 0.48 && this.cur < this.chunks.length - 1) return "right";
    if (nx < -0.48 && this.cur > 0) return "left";
    return null;
  }

  pD(e: PointerEvent, rect: DOMRect): void {
    if (e.button === 2 || e.shiftKey) {
      this.orb = true;
      this.oSX = e.clientX;
      this.oSY = e.clientY;
      this.oSY2 = this.yaw;
      this.oSP = this.pitch;
      return;
    }
    this.flipArm = null;
    if (!this.fl) {
      const side = this.hitSpreadSide(e.clientX, e.clientY, rect);
      if (side === "right" && this.cur < this.chunks.length - 1) this.flipArm = "next";
      else if (side === "left" && this.cur > 0) this.flipArm = "prev";
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

    if (!this.drag) return;
    const drag = ((e.clientX - this.dSX) / rect.width) * Math.PI * 1.5;
    this.ang = Math.max(0, Math.min(Math.PI, this.dSA - drag));
  }

  pU(e: PointerEvent, rect: DOMRect): void {
    this.orb = false;

    const moved = Math.hypot(e.clientX - this.armSX, e.clientY - this.armSY);

    if (!this.drag) {
      if (this.fl === 0 && moved <= this.TAP_MAX_PX) {
        const idx = this.pickAt(e.clientX, e.clientY, rect);
        if (idx !== null && idx >= 0) this.onPickCatalogIndex?.(idx);
        else this.onPickCatalogIndex?.(null);
      }
      this.flipArm = null;
      return;
    }

    this.drag = false;
    this.tgt = this.ang > Math.PI * 0.4 ? Math.PI : 0;
    this.flipArm = null;
  }

  pickAt(clientX: number, clientY: number, rect: DOMRect): number | null {
    this.ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.ndc, this.cam);
    const objs: THREE.Object3D[] = [];
    this.G.traverse((ch) => {
      const m = ch as THREE.Mesh;
      if (m.isMesh && typeof m.userData.pickIndex === "number") objs.push(m);
    });
    const hits = this.raycaster.intersectObjects(objs, false);
    hits.sort((a, b) => a.distance - b.distance);
    let bestRecto: number | null = null;
    for (const h of hits) {
      const m = h.object as THREE.Mesh;
      const pi = m.userData.pickIndex as number;
      if (typeof pi !== "number" || pi < 0) continue;
      if (m.userData.gridPick === true) return pi;
      if (bestRecto === null) bestRecto = pi;
    }
    return bestRecto;
  }

  private _tick(): void {
    if (this.disposed) return;
    const dt = Math.min(0.05, this.clock.getDelta());
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
    this.cam.position.set(
      this.dist * Math.cos(this.pitch) * Math.sin(this.yaw),
      this.dist * Math.sin(this.pitch) + 0.2,
      this.dist * Math.cos(this.pitch) * Math.cos(this.yaw),
    );
    this.cam.lookAt(0, 0, 0);
    this.R.render(this.S, this.cam);
    if (!this.disposed) requestAnimationFrame(this._tick);
  }

  dispose(): void {
    this.disposed = true;
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
    this.shellGroup.traverse((ch) => {
      const m = ch as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    for (const mat of this._shellMaterials) {
      mat.map?.dispose();
      mat.dispose();
    }
    this.G.remove(this.shellGroup);
    this.pg.dispose();
    this.R.dispose();
  }

  isBinderOpen(): boolean {
    return true;
  }

  openBinder(): void {
    /* no-op */
  }

  get pageIndex(): number {
    return this.cur;
  }

  get pageCount(): number {
    return Math.max(1, this.chunks.length);
  }
}
