import * as THREE from "three";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CATALOG, getCatalogEntry } from "../game/catalog";
import { isCommandEntry } from "../game/types";
import { getAssetLabTowerAndUnitGlbFiles, getAssetLabUnitExtraAnimationFiles } from "../render/glbPool";
import {
  clearDoctrineForCard,
  exportDoctrineStoreJson,
  getDoctrineForCard,
  guessUnitClipsFromNames,
  importDoctrineStoreJson,
  mergeDoctrineForCard,
  UNIT_ANIM_ROLES,
  type UnitAnimRole,
} from "./assetLabDoctrine";
import {
  cardArtOverlayHtml,
  CARD_OVERLAY_FIELD_TOGGLES,
  getOverlayFieldVisibilityForCard,
  installCardArtOverlayCalibrator,
  refreshCardArtOverlayUi,
  setCardArtOverlayDevOverrides,
  setCardOverlayEditorMount,
  setCardOverlayWriteKey,
  setOverlayFieldVisibilityForCard,
} from "../ui/cardArtOverlay";
import { getCardArtUrl } from "../ui/cardArtManifest";

const SESSION_KEY = "battleLogs.assetLab.overlayKey";
const FLEX_STORAGE_KEY = "battleLogs.assetLab.portFlex";
const CARD_ZOOM_STORAGE_KEY = "battleLogs.assetLab.cardZoom";

const NORM_SCALE = 2.15;

const canvasTower = document.querySelector<HTMLCanvasElement>("#al-canvas-tower")!;
const canvasUnit = document.querySelector<HTMLCanvasElement>("#al-canvas-unit")!;
const wrapTower = canvasTower.parentElement as HTMLElement;
const wrapUnit = canvasUnit.parentElement as HTMLElement;
const metaTowerEl = document.querySelector<HTMLElement>("#al-meta-tower")!;
const metaUnitEl = document.querySelector<HTMLElement>("#al-meta-unit")!;
const alPorts = document.querySelector<HTMLElement>("#al-ports")!;
const portTower = document.querySelector<HTMLElement>("#al-port-tower")!;
const portUnit = document.querySelector<HTMLElement>("#al-port-unit")!;
const portCard = document.querySelector<HTMLElement>("#al-port-card")!;
const sidebarEl = document.querySelector<HTMLElement>("#al-sidebar")!;
const sidebarToggleBtn = document.querySelector<HTMLButtonElement>("#al-sidebar-toggle")!;

const glbSelect = document.querySelector<HTMLSelectElement>("#al-glb")!;
const clipTowerSelect = document.querySelector<HTMLSelectElement>("#al-clip-tower")!;
const clipUnitSelect = document.querySelector<HTMLSelectElement>("#al-clip-unit")!;
const clipSoloSelect = document.querySelector<HTMLSelectElement>("#al-clip")!;
const pairControlsEl = document.querySelector<HTMLElement>("#al-pair-controls")!;
const soloControlsEl = document.querySelector<HTMLElement>("#al-solo-controls")!;
const loopEl = document.querySelector<HTMLInputElement>("#al-loop")!;
const playTowerBtn = document.querySelector<HTMLButtonElement>("#al-play-tower")!;
const playUnitBtn = document.querySelector<HTMLButtonElement>("#al-play-unit")!;
const playSoloBtn = document.querySelector<HTMLButtonElement>("#al-play-solo")!;
const cardFrame = document.querySelector<HTMLElement>("#al-card-frame")!;
const cardZoomInner = document.querySelector<HTMLElement>("#al-card-zoom-inner")!;
const cardZoomRange = document.querySelector<HTMLInputElement>("#al-card-zoom")!;
const cardZoomPct = document.querySelector<HTMLElement>("#al-card-zoom-pct")!;
const hideOverlayCb = document.querySelector<HTMLInputElement>("#al-hide-overlay")!;
const alRoot = document.querySelector<HTMLElement>("#al-root")!;
const cardIdSelect = document.querySelector<HTMLSelectElement>("#al-card-id")!;
const passInput = document.querySelector<HTMLInputElement>("#al-pass")!;
const unlockBtn = document.querySelector<HTMLButtonElement>("#al-unlock")!;
const lockBtn = document.querySelector<HTMLButtonElement>("#al-lock")!;
const editStatusEl = document.querySelector<HTMLElement>("#al-edit-status")!;
const doctrineWorkflowEl = document.querySelector<HTMLElement>("#al-doctrine-workflow");
const towerGlbSelect = document.querySelector<HTMLSelectElement>("#al-tower-glb");
const unitGlbSelect = document.querySelector<HTMLSelectElement>("#al-unit-glb");
const clipUnitField = document.querySelector<HTMLElement>("#al-clip-unit-field");
const doctrineStatusEl = document.querySelector<HTMLElement>("#al-doctrine-status");
const doctrineResetBtn = document.querySelector<HTMLButtonElement>("#al-doctrine-reset");
const doctrineExportBtn = document.querySelector<HTMLButtonElement>("#al-doctrine-export");
const doctrineImportBtn = document.querySelector<HTMLButtonElement>("#al-doctrine-import-btn");
const doctrineImportInput = document.querySelector<HTMLInputElement>("#al-doctrine-import");

const animRoleSelects = UNIT_ANIM_ROLES.reduce(
  (acc, role) => {
    acc[role] = document.querySelector<HTMLSelectElement>(`#al-anim-${role}`)!;
    return acc;
  },
  {} as Record<UnitAnimRole, HTMLSelectElement>,
);

let rendererTower: THREE.WebGLRenderer;
let rendererUnit: THREE.WebGLRenderer;
let sceneTower: THREE.Scene;
let sceneUnit: THREE.Scene;
let cameraTower: THREE.PerspectiveCamera;
let cameraUnit: THREE.PerspectiveCamera;
let controlsTower: OrbitControls;
let controlsUnit: OrbitControls;
let towerPivot: THREE.Group;
let unitPivot: THREE.Group;

type AnimSlot = {
  root: THREE.Object3D | null;
  mixer: THREE.AnimationMixer | null;
  action: THREE.AnimationAction | null;
  clips: THREE.AnimationClip[];
};

const towerSlot: AnimSlot = { root: null, mixer: null, action: null, clips: [] };
const unitSlot: AnimSlot = { root: null, mixer: null, action: null, clips: [] };

let previewMode: "catalog" | "browse" = "catalog";
/** Which viewport animation doctrine preview focuses (catalog mode). */
let previewRole: UnitAnimRole | "tower" = "run";
let raf = 0;
const clock = new THREE.Clock();

let flexTower = 1;
let flexUnit = 1;
let flexCard = 1;

const gltfLoader = new GLTFLoader();
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath("/draco/gltf/");
gltfLoader.setDRACOLoader(dracoLoader);

function loadFlexFromStorage(): void {
  try {
    const raw = localStorage.getItem(FLEX_STORAGE_KEY);
    if (!raw) return;
    const j = JSON.parse(raw) as unknown;
    if (Array.isArray(j) && j.length === 3) {
      const [a, b, c] = j.map((x) => Number(x));
      if (a > 0 && b > 0 && c > 0) {
        flexTower = a;
        flexUnit = b;
        flexCard = c;
      }
    }
  } catch {
    /* ignore */
  }
}

function saveFlexToStorage(): void {
  try {
    localStorage.setItem(FLEX_STORAGE_KEY, JSON.stringify([flexTower, flexUnit, flexCard]));
  } catch {
    /* ignore */
  }
}

function applyPortFlex(): void {
  portTower.style.flex = `${flexTower} 1 0`;
  portUnit.style.flex = `${flexUnit} 1 0`;
  portCard.style.flex = `${flexCard} 1 0`;
  saveFlexToStorage();
}

function applySessionToOverlayState(): void {
  const key = sessionStorage.getItem(SESSION_KEY);
  setCardOverlayWriteKey(key);
  setCardArtOverlayDevOverrides({ edit: Boolean(key), calibrate: true });
  refreshCardArtOverlayUi();
  editStatusEl.textContent = key
    ? "Edit unlocked — drag stats; Save writes JSON via dev middleware."
    : "View only — stat drag & save disabled.";
  editStatusEl.className = `al-status ${key ? "al-ok" : "al-warn"}`;
  if (key) {
    passInput.placeholder = "Session unlocked (key not shown)";
    passInput.value = "";
  } else {
    passInput.placeholder = "";
  }
}

function applyCardZoomUi(): void {
  const v = clampZoom(Number(cardZoomRange.value));
  cardZoomRange.value = String(v);
  cardZoomInner.style.transform = `scale(${v / 100})`;
  cardZoomPct.textContent = `${v}%`;
  try {
    localStorage.setItem(CARD_ZOOM_STORAGE_KEY, String(v));
  } catch {
    /* ignore */
  }
}

function clampZoom(n: number): number {
  if (!Number.isFinite(n)) return 100;
  return Math.max(50, Math.min(300, Math.round(n / 5) * 5));
}

function loadCardZoomFromStorage(): void {
  try {
    const raw = localStorage.getItem(CARD_ZOOM_STORAGE_KEY);
    if (raw != null) cardZoomRange.value = String(clampZoom(Number(raw)));
  } catch {
    /* ignore */
  }
  applyCardZoomUi();
}

function setupOverlayFieldToggles(): void {
  const wrap = document.querySelector<HTMLElement>("#al-overlay-field-toggles");
  if (!wrap) return;
  wrap.innerHTML = "";
  const catalogId = currentCatalogId();
  const vis = getOverlayFieldVisibilityForCard(catalogId);
  for (const { id, label } of CARD_OVERLAY_FIELD_TOGGLES) {
    const lab = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = vis[id] !== false;
    cb.addEventListener("change", () => {
      setOverlayFieldVisibilityForCard(currentCatalogId(), { [id]: cb.checked });
    });
    lab.append(cb);
    lab.append(document.createTextNode(` ${label}`));
    wrap.append(lab);
  }
}

function mountCardPreview(catalogId: string): void {
  void (async () => {
    const url = await getCardArtUrl(catalogId);
    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    cardFrame.innerHTML = url
      ? `<img alt="" draggable="false" src="${esc(url)}" />${cardArtOverlayHtml(catalogId)}`
      : `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:12px;opacity:.7;padding:8px;text-align:center;">No card art — overlay preview only</div>${cardArtOverlayHtml(catalogId)}`;
    refreshCardArtOverlayUi();
  })();
}

function disposeRootDeep(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.geometry?.dispose();
      const mat = m.material;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    }
  });
}

function clearSlot(pivot: THREE.Group, slot: AnimSlot): void {
  if (slot.action) {
    slot.action.stop();
    slot.action = null;
  }
  slot.mixer = null;
  slot.clips = [];
  if (slot.root) {
    pivot.remove(slot.root);
    disposeRootDeep(slot.root);
    slot.root = null;
  }
}

function countTriangles(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry) {
      const g = m.geometry;
      const idx = g.index;
      const pos = g.attributes.position;
      if (idx) n += idx.count / 3;
      else if (pos) n += pos.count / 3;
    }
  });
  return Math.floor(n);
}

function normalizeRootInPivot(root: THREE.Object3D): void {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const max = Math.max(size.x, size.y, size.z, 1e-3);
  const s = NORM_SCALE / max;
  root.scale.setScalar(s);
  root.position.set(-center.x * s, -box.min.y * s, -center.z * s);
}

function fillClipSelect(sel: HTMLSelectElement, clips: THREE.AnimationClip[]): void {
  sel.innerHTML = "";
  for (const c of clips) {
    const opt = document.createElement("option");
    opt.value = c.name;
    opt.textContent = `${c.name} (${c.duration.toFixed(2)}s)`;
    sel.append(opt);
  }
}

function clipFromSlot(slot: AnimSlot, name: string): THREE.AnimationClip | undefined {
  return slot.clips.find((c) => c.name === name);
}

function playSlotNamed(slot: AnimSlot, clipName: string): void {
  if (!slot.mixer || !slot.clips.length) return;
  const clip = clipFromSlot(slot, clipName);
  if (!clip) return;
  if (slot.action) slot.action.stop();
  slot.action = slot.mixer.clipAction(clip);
  slot.action.setLoop(loopEl.checked ? THREE.LoopRepeat : THREE.LoopOnce, loopEl.checked ? Infinity : 1);
  slot.action.clampWhenFinished = !loopEl.checked;
  slot.action.reset().play();
}

function currentCatalogId(): string {
  return cardIdSelect.value;
}

function effectiveTowerFile(catalogId: string, routed: string | null): string | null {
  const o = getDoctrineForCard(catalogId).towerGlb.trim();
  return o || routed;
}

function effectiveUnitFile(catalogId: string, routed: string | null): string | null {
  const o = getDoctrineForCard(catalogId).unitGlb.trim();
  return o || routed;
}

function setDoctrineStatus(message: string): void {
  if (doctrineStatusEl) doctrineStatusEl.textContent = message;
}

function populateTowerUnitDropdowns(files: readonly string[]): void {
  if (!towerGlbSelect || !unitGlbSelect) return;
  towerGlbSelect.innerHTML = "";
  unitGlbSelect.innerHTML = "";
  const def = document.createElement("option");
  def.value = "";
  def.textContent = "Default (catalog routing)";
  towerGlbSelect.append(def.cloneNode(true) as HTMLOptionElement);
  unitGlbSelect.append(def.cloneNode(true) as HTMLOptionElement);
  for (const f of files) {
    const ot = document.createElement("option");
    ot.value = f;
    ot.textContent = f;
    towerGlbSelect.append(ot.cloneNode(true) as HTMLOptionElement);
    const ou = document.createElement("option");
    ou.value = f;
    ou.textContent = f;
    unitGlbSelect.append(ou);
  }
}

function syncTowerUnitSelectsFromDoctrine(catalogId: string): void {
  if (!towerGlbSelect || !unitGlbSelect) return;
  const d = getDoctrineForCard(catalogId);
  towerGlbSelect.value = d.towerGlb;
  unitGlbSelect.value = d.unitGlb;
}

function fillRoleClipSelects(clips: THREE.AnimationClip[]): void {
  for (const role of UNIT_ANIM_ROLES) {
    const sel = animRoleSelects[role];
    sel.innerHTML = "";
    const optAuto = document.createElement("option");
    optAuto.value = "";
    optAuto.textContent = "— Auto (name guess) —";
    sel.append(optAuto);
    for (const c of clips) {
      const opt = document.createElement("option");
      opt.value = c.name;
      opt.textContent = `${c.name} (${c.duration.toFixed(2)}s)`;
      sel.append(opt);
    }
  }
}

function syncAnimRoleSelectsFromDoctrine(catalogId: string): void {
  const d = getDoctrineForCard(catalogId);
  for (const role of UNIT_ANIM_ROLES) {
    const sel = animRoleSelects[role];
    const want = d.unitClips[role]?.trim() ?? "";
    sel.value = want;
    if (want && !clipFromSlot(unitSlot, want)) sel.value = "";
  }
}

function clipNameForUnitPreview(catalogId: string, role: UnitAnimRole): string | null {
  const d = getDoctrineForCard(catalogId);
  const guessed = guessUnitClipsFromNames(unitSlot.clips);
  const explicit = d.unitClips[role]?.trim();
  const pick = (explicit || guessed[role] || "").trim();
  if (pick && clipFromSlot(unitSlot, pick)) return pick;
  if (unitSlot.clips.length) return unitSlot.clips[0].name;
  return null;
}

function playTowerFromDoctrine(catalogId: string): void {
  const d = getDoctrineForCard(catalogId);
  let name = d.towerClip.trim();
  if (!name && towerSlot.clips.length) name = towerSlot.clips[0].name;
  if (name) playSlotNamed(towerSlot, name);
}

function applyPreviewAnimation(): void {
  if (previewMode !== "catalog") return;
  const id = currentCatalogId();
  if (previewRole === "tower") {
    if (unitSlot.action) {
      unitSlot.action.stop();
      unitSlot.action = null;
    }
    playTowerFromDoctrine(id);
    return;
  }
  const nm = clipNameForUnitPreview(id, previewRole);
  if (nm) playSlotNamed(unitSlot, nm);
}

function playUnitViewportBestEffort(): void {
  const id = currentCatalogId();
  const role: UnitAnimRole = previewRole === "tower" ? "run" : previewRole;
  const nm = clipNameForUnitPreview(id, role);
  if (nm) playSlotNamed(unitSlot, nm);
}

function setPreviewRoleUi(): void {
  document.querySelectorAll<HTMLButtonElement>(".al-preview-role").forEach((b) => {
    b.classList.toggle("al-is-active", b.dataset.previewRole === previewRole);
  });
}

async function loadUrlIntoPivot(
  url: string,
  pivot: THREE.Group,
  slot: AnimSlot,
  errEl: HTMLElement,
): Promise<boolean> {
  clearSlot(pivot, slot);
  try {
    const gltf = await gltfLoader.loadAsync(url);
    slot.root = gltf.scene;
    pivot.add(slot.root);
    normalizeRootInPivot(slot.root);
    slot.clips = gltf.animations ?? [];
    slot.mixer = slot.clips.length ? new THREE.AnimationMixer(slot.root) : null;
    return true;
  } catch (e) {
    errEl.textContent = `Failed to load ${url}: ${e instanceof Error ? e.message : String(e)}`;
    return false;
  }
}

function glbStem(file: string): string {
  return file.replace(/\.glb$/i, "");
}

function pushClipsRenamedBySourceFile(
  clips: readonly THREE.AnimationClip[],
  sourceFile: string,
  usedNames: Set<string>,
  into: THREE.AnimationClip[],
): void {
  const stem = glbStem(sourceFile);
  for (const clip of clips) {
    const c = clip.clone();
    let name = `${stem} — ${clip.name}`;
    if (usedNames.has(name)) {
      let n = 2;
      while (usedNames.has(`${name} (${n})`)) n += 1;
      name = `${name} (${n})`;
    }
    usedNames.add(name);
    c.name = name;
    into.push(c);
  }
}

/**
 * Base GLB supplies the skinned mesh; other GLBs supply extra clips (same skeleton) like in-match `attachGlbForClass`.
 */
async function loadUnitPivotWithMergedClips(
  baseFile: string,
  extraFiles: readonly string[],
  pivot: THREE.Group,
  slot: AnimSlot,
  errEl: HTMLElement,
): Promise<boolean> {
  clearSlot(pivot, slot);
  const usedNames = new Set<string>();
  const merged: THREE.AnimationClip[] = [];
  try {
    const baseUrl = `/assets/units/${encodeURIComponent(baseFile)}`;
    const gltf = await gltfLoader.loadAsync(baseUrl);
    slot.root = gltf.scene;
    pivot.add(slot.root);
    normalizeRootInPivot(slot.root);
    pushClipsRenamedBySourceFile(gltf.animations ?? [], baseFile, usedNames, merged);

    for (const xf of extraFiles) {
      const url = `/assets/units/${encodeURIComponent(xf)}`;
      const g2 = await gltfLoader.loadAsync(url);
      pushClipsRenamedBySourceFile(g2.animations ?? [], xf, usedNames, merged);
      disposeRootDeep(g2.scene);
    }

    slot.clips = merged;
    slot.mixer = merged.length ? new THREE.AnimationMixer(slot.root) : null;
    return true;
  } catch (e) {
    errEl.textContent = `Failed to load unit clips (${baseFile}): ${e instanceof Error ? e.message : String(e)}`;
    return false;
  }
}

function playSlot(slot: AnimSlot, clipSelect: HTMLSelectElement): void {
  if (!slot.mixer || !slot.clips.length) return;
  const name = clipSelect.value;
  const clip = slot.clips.find((c) => c.name === name);
  if (!clip) return;
  if (slot.action) slot.action.stop();
  slot.action = slot.mixer.clipAction(clip);
  slot.action.setLoop(loopEl.checked ? THREE.LoopRepeat : THREE.LoopOnce, loopEl.checked ? Infinity : 1);
  slot.action.clampWhenFinished = !loopEl.checked;
  slot.action.reset().play();
}

function setUiMode(mode: "catalog" | "browse"): void {
  previewMode = mode;
  const catalog = mode === "catalog";
  pairControlsEl.hidden = !catalog;
  soloControlsEl.hidden = catalog;
  playTowerBtn.hidden = !catalog;
  playUnitBtn.hidden = !catalog;
  playSoloBtn.hidden = catalog;
  clipTowerSelect.disabled = !catalog;
  clipUnitSelect.disabled = !catalog;
  clipSoloSelect.disabled = catalog;
  if (doctrineWorkflowEl) doctrineWorkflowEl.hidden = !catalog;
  if (clipUnitField) clipUnitField.hidden = catalog;
}

function setPortCollapsed(port: HTMLElement, collapsed: boolean): void {
  port.classList.toggle("al-port--collapsed", collapsed);
  const btn = port.querySelector<HTMLButtonElement>(".al-port-min");
  if (btn) btn.textContent = port.classList.contains("al-port--collapsed") ? "+" : "−";
}

/** Spells: minimize tower + unit by default (still open with +). Structures: show both 3D ports. */
function applyAssetLabPortsForCatalogKind(catalogId: string): void {
  const entry = getCatalogEntry(catalogId);
  const isSpell = Boolean(entry && isCommandEntry(entry));
  setPortCollapsed(portTower, isSpell);
  setPortCollapsed(portUnit, isSpell);
  resizeRendererPair();
}

function resizeRendererPair(): void {
  const wt = wrapTower.clientWidth;
  const ht = wrapTower.clientHeight;
  if (wt > 0 && ht > 0) {
    cameraTower.aspect = wt / ht;
    cameraTower.updateProjectionMatrix();
    rendererTower.setSize(wt, ht, false);
  }
  const wu = wrapUnit.clientWidth;
  const hu = wrapUnit.clientHeight;
  if (wu > 0 && hu > 0) {
    cameraUnit.aspect = wu / hu;
    cameraUnit.updateProjectionMatrix();
    rendererUnit.setSize(wu, hu, false);
  }
}

async function loadCatalogPair(catalogId: string): Promise<void> {
  setUiMode("catalog");
  metaTowerEl.textContent = "Loading…";
  metaUnitEl.textContent = "Loading…";
  clearSlot(towerPivot, towerSlot);
  clearSlot(unitPivot, unitSlot);
  clipTowerSelect.innerHTML = "";
  clipUnitSelect.innerHTML = "";

  const entry = getCatalogEntry(catalogId);
  const isSpell = Boolean(entry && isCommandEntry(entry));

  syncTowerUnitSelectsFromDoctrine(catalogId);

  const routed = await getAssetLabTowerAndUnitGlbFiles(catalogId);
  const towerFile = effectiveTowerFile(catalogId, routed.towerFile);
  const unitFile = effectiveUnitFile(catalogId, routed.unitFile);

  const linesT: string[] = [];
  const linesU: string[] = [];

  if (!towerFile && !unitFile) {
    if (isSpell) {
      metaTowerEl.textContent = "Spell — no tower / unit GLB.";
      metaUnitEl.textContent = "Use the Card column; + reopens these ports.";
      setDoctrineStatus("Spell: 3D ports empty by design. Minimized — use + on Tower/Unit if you assign GLBs later.");
    } else {
      metaTowerEl.textContent = "No tower GLB for this card.";
      metaUnitEl.textContent = "No unit GLB for this card.";
      setDoctrineStatus("No routed GLB for this catalog entry.");
    }
    applyAssetLabPortsForCatalogKind(catalogId);
    applyPreviewAnimation();
    setPreviewRoleUi();
    return;
  }

  if (towerFile) {
    const ok = await loadUrlIntoPivot(
      `/assets/units/${encodeURIComponent(towerFile)}`,
      towerPivot,
      towerSlot,
      metaTowerEl,
    );
    if (ok && towerSlot.root) {
      linesT.push(towerFile, `${countTriangles(towerSlot.root)} tris`, `${towerSlot.clips.length} clips`);
      fillClipSelect(clipTowerSelect, towerSlot.clips);
      const d = getDoctrineForCard(catalogId);
      let tc = d.towerClip.trim();
      if (tc && clipFromSlot(towerSlot, tc)) clipTowerSelect.value = tc;
      else if (towerSlot.clips.length) {
        clipTowerSelect.selectedIndex = 0;
        tc = towerSlot.clips[0].name;
      }
      if (towerSlot.clips.length) {
        playSlotNamed(towerSlot, clipTowerSelect.value);
      }
    }
    metaTowerEl.textContent = linesT.length ? linesT.join("\n") : metaTowerEl.textContent;
  } else {
    metaTowerEl.textContent = "—";
  }

  if (unitFile) {
    /** Merge idle/attack/death GLBs (same rig) whenever the effective unit file is still the catalog route — not only when the dropdown says "Default". Picking the default file explicitly used to skip merge and left role dropdowns with a single run clip. */
    const routedUnitFile = routed.unitFile;
    const useMergedCatalogClips = Boolean(routedUnitFile && unitFile === routedUnitFile);
    const extraFiles = useMergedCatalogClips ? await getAssetLabUnitExtraAnimationFiles(catalogId) : [];
    const ok =
      useMergedCatalogClips && extraFiles.length > 0
        ? await loadUnitPivotWithMergedClips(unitFile, extraFiles, unitPivot, unitSlot, metaUnitEl)
        : await loadUrlIntoPivot(`/assets/units/${encodeURIComponent(unitFile)}`, unitPivot, unitSlot, metaUnitEl);
    if (ok && unitSlot.root) {
      const clipLine =
        useMergedCatalogClips && extraFiles.length > 0
          ? `${unitSlot.clips.length} clips (base + ${extraFiles.length} role GLB${extraFiles.length === 1 ? "" : "s"})`
          : `${unitSlot.clips.length} clips`;
      linesU.push(unitFile, `${countTriangles(unitSlot.root)} tris`, clipLine);
      if (useMergedCatalogClips && extraFiles.length > 0) {
        linesU.push(`Merged: ${extraFiles.join(", ")}`);
      }
      fillClipSelect(clipUnitSelect, unitSlot.clips);
      fillRoleClipSelects(unitSlot.clips);
      syncAnimRoleSelectsFromDoctrine(catalogId);
      if (unitSlot.clips.length) clipUnitSelect.selectedIndex = 0;
    }
    metaUnitEl.textContent = linesU.length ? linesU.join("\n") : metaUnitEl.textContent;
  } else {
    metaUnitEl.textContent = "—";
  }

  applyPreviewAnimation();
  setPreviewRoleUi();
  setDoctrineStatus(`Doctrine stored locally for “${catalogId}” (export JSON to share).`);
  applyAssetLabPortsForCatalogKind(catalogId);
}

async function loadBrowseSolo(file: string): Promise<void> {
  setUiMode("browse");
  metaTowerEl.textContent = "Browse mode — empty";
  metaUnitEl.textContent = "Loading…";
  clearSlot(towerPivot, towerSlot);
  clearSlot(unitPivot, unitSlot);
  clipSoloSelect.innerHTML = "";

  const url = `/assets/units/${encodeURIComponent(file)}`;
  const ok = await loadUrlIntoPivot(url, unitPivot, unitSlot, metaUnitEl);
  if (!ok) return;

  const lines = [file, `${unitSlot.root ? countTriangles(unitSlot.root) : 0} tris`, `${unitSlot.clips.length} clips`];
  fillClipSelect(clipSoloSelect, unitSlot.clips);
  if (unitSlot.clips.length) {
    clipSoloSelect.selectedIndex = 0;
    metaUnitEl.textContent = lines.join("\n");
    playSlot(unitSlot, clipSoloSelect);
  } else {
    metaUnitEl.textContent = `${lines.join("\n")}\n(no clips)`;
  }
}

function animateLoop(): void {
  raf = requestAnimationFrame(animateLoop);
  const dt = clock.getDelta();
  controlsTower.update();
  controlsUnit.update();
  towerSlot.mixer?.update(dt);
  unitSlot.mixer?.update(dt);
  rendererTower.render(sceneTower, cameraTower);
  rendererUnit.render(sceneUnit, cameraUnit);
}

function setupGutterDrag(): void {
  const gutters = document.querySelectorAll<HTMLElement>(".al-gutter[data-gutter]");
  let drag: { idx: 0 | 1; startP: number; ft: number; fu: number; fc: number } | null = null;

  const isVerticalStack = (): boolean => window.matchMedia("(max-width: 900px)").matches;

  const primarySize = (): number => {
    const vert = isVerticalStack();
    return Math.max(1, vert ? alPorts.clientHeight : alPorts.clientWidth);
  };

  const pointerPrimary = (ev: PointerEvent): number =>
    isVerticalStack() ? ev.clientY : ev.clientX;

  const onMove = (ev: PointerEvent): void => {
    if (!drag) return;
    const d = pointerPrimary(ev) - drag.startP;
    const dFlex = (d / primarySize()) * 5;
    if (drag.idx === 0) {
      flexTower = Math.max(0.2, drag.ft + dFlex);
      flexUnit = Math.max(0.2, drag.fu - dFlex);
    } else {
      flexUnit = Math.max(0.2, drag.fu + dFlex);
      flexCard = Math.max(0.2, drag.fc - dFlex);
    }
    applyPortFlex();
    resizeRendererPair();
  };

  const onUp = (): void => {
    drag = null;
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
  };

  gutters.forEach((gutter) => {
    gutter.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      const idx = Number(gutter.dataset.gutter) === 1 ? 1 : 0;
      drag = {
        idx: idx as 0 | 1,
        startP: pointerPrimary(ev),
        ft: flexTower,
        fu: flexUnit,
        fc: flexCard,
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    });
  });
}

function setupPortMinimize(): void {
  document.querySelectorAll<HTMLButtonElement>(".al-port-min").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.port;
      const port = id === "tower" ? portTower : id === "unit" ? portUnit : portCard;
      port.classList.toggle("al-port--collapsed");
      btn.textContent = port.classList.contains("al-port--collapsed") ? "+" : "−";
      resizeRendererPair();
    });
  });
}

async function bootstrap(): Promise<void> {
  loadFlexFromStorage();
  applyPortFlex();

  const overlayEditorHost = document.getElementById("al-overlay-editor-host");
  setCardOverlayEditorMount(overlayEditorHost);

  const res = await fetch("/assets/units/manifest.json", { cache: "no-store" });
  const manifest = (await res.json()) as { files?: string[] };
  const files = manifest.files ?? [];
  for (const f of files) {
    const opt = document.createElement("option");
    opt.value = f;
    opt.textContent = f;
    glbSelect.append(opt);
  }
  populateTowerUnitDropdowns(files);

  for (const entry of CATALOG) {
    const opt = document.createElement("option");
    opt.value = entry.id;
    opt.textContent = `${entry.id} — ${entry.name}`;
    cardIdSelect.append(opt);
  }

  const mkRenderer = (canvas: HTMLCanvasElement): THREE.WebGLRenderer => {
    const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    return r;
  };

  rendererTower = mkRenderer(canvasTower);
  rendererUnit = mkRenderer(canvasUnit);

  sceneTower = new THREE.Scene();
  sceneTower.background = new THREE.Color(0x070a10);
  sceneUnit = new THREE.Scene();
  sceneUnit.background = new THREE.Color(0x070a10);

  cameraTower = new THREE.PerspectiveCamera(42, 1, 0.06, 200);
  cameraTower.position.set(2.2, 1.45, 2.85);
  cameraUnit = new THREE.PerspectiveCamera(42, 1, 0.06, 200);
  cameraUnit.position.set(2.2, 1.45, 2.85);

  towerPivot = new THREE.Group();
  unitPivot = new THREE.Group();
  sceneTower.add(towerPivot);
  sceneUnit.add(unitPivot);

  const ambT = new THREE.AmbientLight(0xffffff, 0.52);
  const keyT = new THREE.DirectionalLight(0xfff0e0, 1.05);
  keyT.position.set(-3.2, 5.5, 4.2);
  const fillT = new THREE.DirectionalLight(0xc8dcff, 0.35);
  fillT.position.set(4, 2.5, -2);
  sceneTower.add(ambT, keyT, fillT);

  const ambU = new THREE.AmbientLight(0xffffff, 0.52);
  const keyU = new THREE.DirectionalLight(0xfff0e0, 1.05);
  keyU.position.set(-3.2, 5.5, 4.2);
  const fillU = new THREE.DirectionalLight(0xc8dcff, 0.35);
  fillU.position.set(4, 2.5, -2);
  sceneUnit.add(ambU, keyU, fillU);

  controlsTower = new OrbitControls(cameraTower, canvasTower);
  controlsTower.target.set(0, 0.85, 0);
  controlsTower.update();
  controlsUnit = new OrbitControls(cameraUnit, canvasUnit);
  controlsUnit.target.set(0, 0.85, 0);
  controlsUnit.update();

  resizeRendererPair();
  window.addEventListener("resize", resizeRendererPair);
  new ResizeObserver(resizeRendererPair).observe(alPorts);

  setupGutterDrag();
  setupPortMinimize();

  sidebarToggleBtn.addEventListener("click", () => {
    sidebarEl.classList.toggle("al-sidebar--collapsed");
    sidebarToggleBtn.title = sidebarEl.classList.contains("al-sidebar--collapsed") ? "Show controls" : "Hide controls";
    resizeRendererPair();
  });

  const storedKey = sessionStorage.getItem(SESSION_KEY);
  if (storedKey) {
    passInput.value = "";
    passInput.placeholder = "Session unlocked (key not shown)";
  }

  applySessionToOverlayState();
  installCardArtOverlayCalibrator();

  loadCardZoomFromStorage();
  cardZoomRange.addEventListener("input", applyCardZoomUi);
  hideOverlayCb.addEventListener("change", () => {
    alRoot.classList.toggle("al-hide-card-overlay", hideOverlayCb.checked);
  });
  setupOverlayFieldToggles();

  towerGlbSelect?.addEventListener("change", () => {
    mergeDoctrineForCard(currentCatalogId(), { towerGlb: towerGlbSelect!.value });
    void loadCatalogPair(currentCatalogId());
  });
  unitGlbSelect?.addEventListener("change", () => {
    mergeDoctrineForCard(currentCatalogId(), { unitGlb: unitGlbSelect!.value });
    void loadCatalogPair(currentCatalogId());
  });

  for (const role of UNIT_ANIM_ROLES) {
    animRoleSelects[role].addEventListener("change", () => {
      mergeDoctrineForCard(currentCatalogId(), {
        unitClips: { [role]: animRoleSelects[role].value },
      });
      applyPreviewAnimation();
    });
  }

  document.querySelectorAll<HTMLButtonElement>(".al-preview-role").forEach((b) => {
    b.addEventListener("click", () => {
      const r = b.dataset.previewRole;
      if (r === "tower") previewRole = "tower";
      else if (r === "run" || r === "idle" || r === "attack" || r === "die") previewRole = r;
      setPreviewRoleUi();
      applyPreviewAnimation();
    });
  });

  doctrineResetBtn?.addEventListener("click", () => {
    clearDoctrineForCard(currentCatalogId());
    void loadCatalogPair(currentCatalogId());
    setDoctrineStatus("Reset doctrine for this card.");
  });

  doctrineExportBtn?.addEventListener("click", () => {
    const blob = new Blob([exportDoctrineStoreJson()], { type: "application/json" });
    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = "asset-lab-doctrine.json";
    a.click();
    URL.revokeObjectURL(url);
    setDoctrineStatus("Exported all saved doctrines.");
  });

  doctrineImportBtn?.addEventListener("click", () => doctrineImportInput?.click());

  doctrineImportInput?.addEventListener("change", () => {
    const file = doctrineImportInput.files?.[0];
    doctrineImportInput.value = "";
    if (!file) return;
    void (async () => {
      const text = await file.text();
      const r = importDoctrineStoreJson(text);
      if (r.error) setDoctrineStatus(`Import failed: ${r.error}`);
      else setDoctrineStatus(`Imported ${r.merged} card doctrine record(s).`);
      await loadCatalogPair(currentCatalogId());
    })();
  });

  cardIdSelect.addEventListener("change", () => {
    const id = cardIdSelect.value;
    previewRole = "run";
    setupOverlayFieldToggles();
    mountCardPreview(id);
    void loadCatalogPair(id);
  });

  glbSelect.addEventListener("change", () => void loadBrowseSolo(glbSelect.value));

  clipTowerSelect.addEventListener("change", () => {
    mergeDoctrineForCard(currentCatalogId(), { towerClip: clipTowerSelect.value });
    playSlotNamed(towerSlot, clipTowerSelect.value);
  });
  clipUnitSelect.addEventListener("change", () => {
    playSlot(unitSlot, clipUnitSelect);
  });
  clipSoloSelect.addEventListener("change", () => playSlot(unitSlot, clipSoloSelect));
  loopEl.addEventListener("change", () => {
    if (previewMode === "catalog") {
      if (towerSlot.clips.length) playSlotNamed(towerSlot, clipTowerSelect.value);
      applyPreviewAnimation();
    } else {
      playSlot(unitSlot, clipSoloSelect);
    }
  });
  playTowerBtn.addEventListener("click", () => {
    if (towerSlot.clips.length) playSlotNamed(towerSlot, clipTowerSelect.value);
  });
  playUnitBtn.addEventListener("click", () => {
    if (previewMode === "browse") playSlot(unitSlot, clipUnitSelect);
    else playUnitViewportBestEffort();
  });
  playSoloBtn.addEventListener("click", () => playSlot(unitSlot, clipSoloSelect));

  unlockBtn.addEventListener("click", () => {
    const pw = passInput.value.trim();
    if (!pw) {
      editStatusEl.textContent = "Enter the write key first.";
      return;
    }
    sessionStorage.setItem(SESSION_KEY, pw);
    passInput.value = "";
    passInput.placeholder = "Session unlocked (key not shown)";
    applySessionToOverlayState();
  });

  lockBtn.addEventListener("click", () => {
    sessionStorage.removeItem(SESSION_KEY);
    passInput.placeholder = "";
    applySessionToOverlayState();
  });

  mountCardPreview(cardIdSelect.value);
  await loadCatalogPair(cardIdSelect.value);

  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(animateLoop);
}

void bootstrap();
