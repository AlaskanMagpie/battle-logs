import * as THREE from "three";
import { createBinderCardBackTexture } from "./binderCardBackTexture";

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
  bg: 0x0a0a0f,
} as const;

/** 3×3 cells per page (matches catalog binder reference: nine sleeves per face). */
export const BINDER_COLS = 3;
export const BINDER_ROWS = 3;
export const BINDER_CELLS_PER_PAGE = BINDER_COLS * BINDER_ROWS;

const colW = (BINDER_CFG.pageWidth - BINDER_CFG.seamGap * 2) / BINDER_COLS;
const rowH = (BINDER_CFG.pageHeight - BINDER_CFG.seamGap * 2) / BINDER_ROWS;
const TEX_H = Math.round((BINDER_CFG.panelTexW * rowH) / colW);

/** Pixel size for doctrine faces rasterized to binder panels (matches original TEX_H math). */
export function binderPanelPixelSize(): { w: number; h: number } {
  return { w: BINDER_CFG.panelTexW, h: TEX_H };
}

/** Unlit: card art reads correctly; back face uses `uB` for page-turn quads. */
const VS = `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;
const FS = `precision highp float;uniform sampler2D uF;uniform sampler2D uB;varying vec2 vUv;void main(){bool f=gl_FrontFacing;vec4 c=f?texture2D(uF,vUv):texture2D(uB,vec2(1.-vUv.x,vUv.y));gl_FragColor=c;}`;

/** Procedural empty panel (matches original renderPanel(null)). */
export function makeEmptyBinderPanelCanvas(): HTMLCanvasElement {
  const W = BINDER_CFG.panelTexW;
  const H = TEX_H;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d");
  if (!ctx) return c;
  const b = 14;
  const rr = (x: number, y: number, w: number, h: number, r: number): void => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  };
  ctx.fillStyle = "#111318";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(255,255,255,.12)";
  for (let i = 0; i < 20; i++) {
    const t = i / 19;
    ctx.fillRect(6 + t * (W - 12), 3, 2, 2);
    ctx.fillRect(6 + t * (W - 12), H - 5, 2, 2);
  }
  for (let i = 0; i < 28; i++) {
    const t = i / 27;
    ctx.fillRect(3, 6 + t * (H - 12), 2, 2);
    ctx.fillRect(W - 5, 6 + t * (H - 12), 2, 2);
  }
  ctx.fillStyle = "#08090e";
  rr(b, b, W - b * 2, H - b * 2, 8);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,.06)";
  rr(b + 4, b + 4, W - b * 2 - 8, H - b * 2 - 8, 6);
  ctx.fill();
  return c;
}

function makeEmptyTexture(): THREE.CanvasTexture {
  const c = makeEmptyBinderPanelCanvas();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export type SheetPair = { front: number[]; back: number[] };

export class CardBinderEngine {
  readonly R: THREE.WebGLRenderer;
  readonly S: THREE.Scene;
  readonly cam: THREE.PerspectiveCamera;
  readonly G: THREE.Group;
  private readonly pg: THREE.PlaneGeometry;
  private etex: THREE.CanvasTexture;
  /** Shared verso art for all sleeves (one texture for the whole binder). */
  private readonly cardBackTex: THREE.CanvasTexture;
  private ctex: THREE.Texture[];
  private sheets: SheetPair[];
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
  /** Default orbit so the catalog page (right-hand panels) faces the camera. */
  private yaw = -0.22;
  private pitch = -0.12;
  /** Doctrine assignment: catalog order + slots for green panel outlines in 3D. */
  private doctrOrder: string[] = [];
  private doctrSlots: (string | null)[] = Array.from({ length: 16 }, () => null);
  private doctrActive: number | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();

  /** Called after each page settle. */
  onPageChange: ((page: number, total: number) => void) | null = null;
  /** Flat catalog texture index (>=0), or null if empty / miss. */
  onPickCatalogIndex: ((index: number | null) => void) | null = null;

  private flipArm: "next" | "prev" | null = null;
  private armSX = 0;
  private armSY = 0;
  private readonly FLIP_ARM_PX = 28;
  private readonly TAP_MAX_PX = 14;

  constructor(canvas: HTMLCanvasElement, textures: THREE.Texture[]) {
    this.R = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.R.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.R.outputColorSpace = THREE.SRGBColorSpace;
    /* CanvasTexture panels are already display-referred; ACES here crushes unlit ShaderMaterial faces. */
    this.R.toneMapping = THREE.NoToneMapping;
    this.R.toneMappingExposure = 1;

    this.S = new THREE.Scene();
    this.S.background = new THREE.Color(BINDER_CFG.bg);
    this.cam = new THREE.PerspectiveCamera(40, 1, 0.1, 100);

    this.S.add(new THREE.AmbientLight(0xffffff, 0.4));
    const l1 = new THREE.DirectionalLight(0xfff8ee, 1);
    l1.position.set(1, 3, 4);
    this.S.add(l1);
    const l2 = new THREE.DirectionalLight(0xddeeff, 0.4);
    l2.position.set(-2, 1, 3);
    this.S.add(l2);
    const l3 = new THREE.DirectionalLight(0x8899cc, 0.3);
    l3.position.set(0, -1, -3);
    this.S.add(l3);

    this.G = new THREE.Group();
    this.S.add(this.G);

    const sm = new THREE.MeshStandardMaterial({ color: 0x1a1a24, roughness: 0.7, metalness: 0.1 });
    const sp = new THREE.Mesh(new THREE.BoxGeometry(0.08, BINDER_CFG.pageHeight + 0.3, 0.12), sm);
    sp.position.set(0, 0, -0.02);
    this.G.add(sp);

    const rm = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.3, metalness: 0.8 });
    for (let i = -1; i <= 1; i++) {
      const rn = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.01, 12, 24), rm);
      rn.position.set(0, i * 0.8, 0.02);
      rn.rotation.y = Math.PI / 2;
      this.G.add(rn);
    }

    this.pg = new THREE.PlaneGeometry(colW, rowH);
    this.etex = makeEmptyTexture();
    this.cardBackTex = createBinderCardBackTexture();
    this.ctex = textures;
    this.sheets = this._mkSheets();

    this._v();
    this._tick = this._tick.bind(this);
    requestAnimationFrame(this._tick);
  }

  private _emptyChunk(): number[] {
    return Array.from({ length: BINDER_CELLS_PER_PAGE }, () => -1);
  }

  private _sheetHasContent(sh: SheetPair): boolean {
    return sh.front.some((ix) => ix >= 0) || sh.back.some((ix) => ix >= 0);
  }

  /**
   * Duplex leaves: each sheet pairs two page-chunks as recto/verso (`front` / `back`).
   * Matches `_v` (idle left page = previous sheet's `back`) and `_sf` (turning leaf samples both sides).
   */
  private _mkSheets(): SheetPair[] {
    const n = this.ctex.length;
    const cell = BINDER_CELLS_PER_PAGE;
    const chunks: number[][] = [];
    for (let i = 0; i < n; i += cell) {
      chunks.push(Array.from({ length: cell }, (_, k) => (i + k < n ? i + k : -1)));
    }
    const s: SheetPair[] = [];
    for (let p = 0; p < chunks.length; p += 2) {
      const front = chunks[p]!;
      const back = chunks[p + 1] ?? this._emptyChunk();
      s.push({ front, back });
    }
    while (s.length > 0 && !this._sheetHasContent(s[s.length - 1]!)) {
      s.pop();
    }
    if (s.length === 0) {
      const e = this._emptyChunk();
      s.push({ front: e, back: this._emptyChunk() });
    }
    return s;
  }

  private _mat(f: THREE.Texture, b: THREE.Texture): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: {
        uF: { value: f },
        uB: { value: b },
      },
      vertexShader: VS,
      fragmentShader: FS,
      side: THREE.DoubleSide,
    });
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

  private _sp(idx: number[], side: number): THREE.Group {
    const g = new THREE.Group();
    for (let r = 0; r < BINDER_ROWS; r++) {
      for (let c = 0; c < BINDER_COLS; c++) {
        const ti = idx[r * BINDER_COLS + c]!;
        const t = this._gT(ti);
        const m = this._mat(t, this.cardBackTex);
        const ms = new THREE.Mesh(this.pg, m);
        ms.position.set(
          side > 0 ? this._cX(c) : -(BINDER_CFG.pageWidth - this._cX(c)),
          this._rY(r),
          0,
        );
        ms.userData.pickIndex = ti;
        g.add(ms);
      }
    }
    return g;
  }

  private _fp2(fi: number[], _bi: number[]): THREE.Group {
    const root = new THREE.Group();
    let par: THREE.Object3D = root;
    for (let c = 0; c < BINDER_COLS; c++) {
      let cg: THREE.Group;
      if (c === 0) {
        cg = new THREE.Group();
        par.add(cg);
      } else {
        const pv = new THREE.Group();
        pv.position.set(colW + BINDER_CFG.seamGap, 0, 0);
        pv.userData = { seam: true, ci: c };
        par.add(pv);
        cg = pv;
      }
      for (let r = 0; r < BINDER_ROWS; r++) {
        const ft = this._gT(fi[r * BINDER_COLS + c]!);
        const m = this._mat(ft, this.cardBackTex);
        const ms = new THREE.Mesh(this.pg, m);
        ms.position.set(colW / 2, this._rY(r), 0);
        ms.userData.row = r;
        ms.userData.pickIndex = fi[r * BINDER_COLS + c]!;
        cg.add(ms);
      }
      par = cg;
    }
    return root;
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
    /** Left page: opening spread uses both faces of leaf 0 (back left, front right); later spreads use previous leaf's back. */
    const backForLeft =
      s === 0 && this.sheets[0]
        ? this.sheets[0].back
        : s > 0 && this.sheets[s - 1]
          ? this.sheets[s - 1]!.back
          : null;
    if (backForLeft && backForLeft.some((ix) => ix >= 0)) {
      this.lp = this._sp(backForLeft, -1);
      this.lp.position.z = -0.005;
      this.G.add(this.lp);
    }
    if (this.sheets[s]) {
      this.rp = this._sp(this.sheets[s]!.front, 1);
      this.rp.position.z = -0.005;
      this.G.add(this.rp);
    }
    this._notifyPage();
    this._applyPanelHighlights();
  }

  private _sf(): void {
    this._cl(this.fp);
    this.fp = null;
    const s = this.cur;
    if (this.fl === 1 && this.sheets[s]) {
      this.fp = this._fp2(this.sheets[s]!.front, this.sheets[s]!.back);
      this.G.add(this.fp);
      this._cl(this.rp);
      this.rp = null;
      if (this.sheets[s + 1]) {
        this.rp = this._sp(this.sheets[s + 1]!.front, 1);
        this.rp.position.z = -0.005;
        this.G.add(this.rp);
      }
      this._applyPanelHighlights();
    }
    if (this.fl === -1 && this.sheets[s - 1]) {
      this.fp = this._fp2(this.sheets[s - 1]!.front, this.sheets[s - 1]!.back);
      this.fp.rotation.y = -Math.PI;
      this.ang = Math.PI;
      this.G.add(this.fp);
      this._cl(this.lp);
      this.lp = null;
      const underBack =
        s >= 2 && this.sheets[s - 2]
          ? this.sheets[s - 2]!.back
          : s === 1 && this.sheets[0]
            ? this.sheets[0]!.front
            : null;
      if (underBack && underBack.some((ix) => ix >= 0)) {
        this.lp = this._sp(underBack, -1);
        this.lp.position.z = -0.005;
        this.G.add(this.lp);
      }
      this._applyPanelHighlights();
    }
  }

  private _aa(a: number): void {
    if (!this.fp) return;
    this.fp.rotation.y = -a;
    const sm = Math.sin(a) * BINDER_CFG.seamFlex;
    this.fp.traverse((ch) => {
      const u = ch.userData as { seam?: boolean; ci?: number; row?: number };
      if (u.seam) ch.rotation.y = sm * ((u.ci ?? 0) * 0.6);
      if (u.row !== undefined) {
        const mid = (BINDER_ROWS - 1) * 0.5;
        ch.rotation.x = (u.row - mid) * Math.sin(a) * BINDER_CFG.rowDroop;
      }
    });
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
    this.onPageChange?.(this.cur, Math.max(1, this.sheets.length));
  }

  flipNext(): void {
    if (this.fl || this.cur >= this.sheets.length - 1) return;
    this.fl = 1;
    this.ang = 0;
    this.vel = 0;
    this.tgt = Math.PI;
    this._sf();
  }

  flipPrev(): void {
    if (this.fl || this.cur <= 0) return;
    this.fl = -1;
    this.ang = Math.PI;
    this.vel = 0;
    this.tgt = 0;
    this._sf();
  }

  /** Replace panel textures. Caller owns texture lifecycle (global cache); engine does not dispose prior `ctex`. */
  setTextures(incoming: THREE.Texture[]): void {
    this.ctex = [...incoming];
    this.sheets = this._mkSheets();
    this.cur = Math.min(this.cur, Math.max(0, this.sheets.length - 1));
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
    this.yaw = -0.22;
    this.pitch = -0.12;
    this.dist = 5.8;
  }

  /**
   * Highlights binder panels whose card is currently in the doctrine deck (green edge).
   * `activeSlot` doctrine card uses a brighter outline when it matches a panel.
   */
  syncDoctrineHighlights(
    orderedCatalogIds: readonly string[],
    slots: readonly (string | null)[],
    activeSlot: number | null,
  ): void {
    this.doctrOrder = [...orderedCatalogIds];
    this.doctrSlots = slots.length ? [...slots] : Array.from({ length: 16 }, () => null);
    while (this.doctrSlots.length < 16) this.doctrSlots.push(null);
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

  pD(e: PointerEvent, rect: DOMRect): void {
    if (e.button === 2 || e.shiftKey) {
      this.orb = true;
      this.oSX = e.clientX;
      this.oSY = e.clientY;
      this.oSY2 = this.yaw;
      this.oSP = this.pitch;
      return;
    }
    if (this.fl) return;

    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.flipArm = null;
    if (nx > 0.35 && this.cur < this.sheets.length - 1) this.flipArm = "next";
    else if (nx < -0.35 && this.cur > 0) this.flipArm = "prev";

    this.armSX = e.clientX;
    this.armSY = e.clientY;
    this.drag = false;
    this.dSX = e.clientX;
    this.dSA = this.flipArm === "prev" ? Math.PI : 0;
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
        this.ang = Math.PI;
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
    this.ang = Math.max(0, Math.min(Math.PI, this.dSA - ((e.clientX - this.dSX) / rect.width) * Math.PI * 1.5));
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
    this.tgt = this.fl === 1 ? (this.ang > Math.PI * 0.4 ? Math.PI : 0) : this.ang < Math.PI * 0.6 ? 0 : Math.PI;
    this.flipArm = null;
  }

  /** Raycast visible binder panels; returns texture index or null. */
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
    for (const h of hits) {
      const pi = (h.object as THREE.Mesh).userData.pickIndex as number;
      if (typeof pi === "number" && pi >= 0) return pi;
    }
    return null;
  }

  private _tick(): void {
    if (this.disposed) return;
    const dt = Math.min(0.05, this.clock.getDelta());
    if (this.fl && !this.drag && this.tgt !== null) {
      this.vel += (-BINDER_CFG.springStiff * (this.ang - this.tgt) - BINDER_CFG.springDamp * this.vel) * dt;
      this.ang += this.vel * dt;
      if (
        (this.fl === 1 && this.tgt === Math.PI && this.ang >= Math.PI - 0.01) ||
        (this.fl === -1 && this.tgt === 0 && this.ang <= 0.01)
      ) {
        if (Math.abs(this.vel) < 0.3) this._done();
      } else if (
        (this.fl === 1 && this.tgt === 0 && this.ang <= 0.01) ||
        (this.fl === -1 && this.tgt === Math.PI && this.ang >= Math.PI - 0.01)
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
    this.cardBackTex.dispose();
    this.etex.dispose();
    this._cl(this.lp);
    this._cl(this.rp);
    this._cl(this.fp);
    this.lp = this.rp = this.fp = null;
    this.pg.dispose();
    this.R.dispose();
  }

  get pageIndex(): number {
    return this.cur;
  }

  get pageCount(): number {
    return Math.max(1, this.sheets.length);
  }
}
