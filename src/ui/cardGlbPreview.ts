import * as THREE from "three";
import { getCatalogPreviewAssetUrl, loadGltfTemplateRoot } from "../render/glbPool";

const dataUrlCache = new Map<string, string | null>();

/** One shared WebGL studio — `getCardPreviewDataUrl` must never run concurrently or pivots fight. */
let previewSerial: Promise<void> = Promise.resolve();

let studio: {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  pivot: THREE.Group;
} | null = null;

const PREVIEW_PX = 256;

function ensureStudio(): void {
  if (studio) return;
  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setSize(PREVIEW_PX, PREVIEW_PX, false);
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = false;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.08, 120);
  camera.position.set(2.4, 1.85, 2.9);
  camera.lookAt(0, 0.55, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 0.52));
  const key = new THREE.DirectionalLight(0xfff0e0, 1.05);
  key.position.set(-3.2, 5.5, 4.2);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xc8dcff, 0.35);
  fill.position.set(4, 2.5, -2);
  scene.add(fill);

  const pivot = new THREE.Group();
  scene.add(pivot);

  studio = { renderer, scene, camera, pivot };
}

/**
 * Renders a single PNG data URL for a catalog id (cached). Returns null if no asset / load fails.
 */
export async function getCardPreviewDataUrl(catalogId: string): Promise<string | null> {
  const cached = dataUrlCache.get(catalogId);
  if (cached !== undefined) return cached;

  const run = async (): Promise<string | null> => {
    const dup = dataUrlCache.get(catalogId);
    if (dup !== undefined) return dup;

    const assetUrl = await getCatalogPreviewAssetUrl(catalogId);
    if (!assetUrl) {
      dataUrlCache.set(catalogId, null);
      return null;
    }

    ensureStudio();
    const { renderer, scene, camera, pivot } = studio!;

    while (pivot.children.length) {
      pivot.remove(pivot.children[0]!);
    }

    try {
      const template = await loadGltfTemplateRoot(assetUrl);
      const root = template.clone(true);
      pivot.add(root);

      root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(root);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const max = Math.max(size.x, size.y, size.z, 1e-3);
      const s = 2.35 / max;
      root.scale.setScalar(s);
      root.position.set(-center.x * s, -box.min.y * s, -center.z * s);

      renderer.render(scene, camera);
      const dataUrl = renderer.domElement.toDataURL("image/png");
      dataUrlCache.set(catalogId, dataUrl);
      return dataUrl;
    } catch {
      dataUrlCache.set(catalogId, null);
      return null;
    } finally {
      while (pivot.children.length) {
        pivot.remove(pivot.children[0]!);
      }
    }
  };

  const out = previewSerial.then(run);
  previewSerial = out.then(
    () => {},
    () => {},
  );
  return out;
}

/** Warm the PNG preview cache for every id (sequential GL studio use — safe for WebGL). */
export async function preloadCardPreviewDataUrls(catalogIds: readonly string[]): Promise<void> {
  const seen = new Set<string>();
  for (const id of catalogIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    await getCardPreviewDataUrl(id);
  }
}

/** Fill preview `<img data-catalog-preview>` nodes under `root` (best-effort, async). */
export function hydrateCardPreviewImages(root: ParentNode): void {
  const imgs = root.querySelectorAll("img.tcg-card-preview-img[data-catalog-preview]");
  for (const el of imgs) {
    const img = el as HTMLImageElement;
    const id = img.dataset.catalogPreview;
    if (!id || img.dataset.previewPending === "1") continue;
    if (img.getAttribute("src") && img.getAttribute("src")!.length > 8) continue;

    const warm = dataUrlCache.get(id);
    if (warm !== undefined) {
      const fb = img.parentElement?.querySelector(".tcg-portrait-fallback") as HTMLElement | null;
      if (warm) {
        img.removeAttribute("hidden");
        if (fb) fb.style.display = "none";
        img.src = warm;
      } else {
        img.setAttribute("hidden", "");
        if (fb) fb.style.display = "";
      }
      continue;
    }

    img.dataset.previewPending = "1";
    void (async () => {
      try {
        const url = await getCardPreviewDataUrl(id);
        const fb = img.parentElement?.querySelector(".tcg-portrait-fallback") as HTMLElement | null;
        if (!url) return;
        const showRaster = (): void => {
          img.removeAttribute("hidden");
          if (fb) fb.style.display = "none";
        };
        img.onload = showRaster;
        img.onerror = () => {
          img.setAttribute("hidden", "");
          if (fb) fb.style.display = "";
        };
        img.src = url;
        if (img.complete && img.naturalWidth > 0) showRaster();
      } finally {
        delete img.dataset.previewPending;
      }
    })();
  }
}
