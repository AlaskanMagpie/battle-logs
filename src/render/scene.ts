import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { getCatalogEntry } from "../game/catalog";
import type { GameState } from "../game/state";
import type { UnitSizeClass } from "../game/types";
import { isStructureEntry } from "../game/types";
import { attachGlbFromManifest, hashStringToSeed, requestGlbForSeed, setGlbOpacity } from "./glbPool";

function unitScale(size: UnitSizeClass): number {
  switch (size) {
    case "Swarm":
      return 0.45;
    case "Line":
      return 0.65;
    case "Heavy":
      return 1.05;
    case "Titan":
      return 1.55;
  }
}

function structureDims(catalogId: string): { w: number; h: number; d: number } {
  const e = getCatalogEntry(catalogId);
  if (e && isStructureEntry(e)) {
    if (e.producedSizeClass === "Titan") return { w: 4.8, h: 9, d: 4.8 };
    if (e.producedSizeClass === "Heavy") return { w: 4.2, h: 5.5, d: 4.2 };
    if (e.signalTypes.filter((s) => s === "Bastion").length >= 2) return { w: 6, h: 3.4, d: 6 };
    if (e.signalTypes.includes("Vanguard") && e.signalTypes.includes("Reclaim")) return { w: 3.8, h: 5.2, d: 3.8 };
    if (e.signalTypes.includes("Vanguard")) return { w: 2.4, h: 7, d: 2.4 };
    if (e.signalTypes.includes("Reclaim")) return { w: 3.6, h: 4.5, d: 3.6 };
  }
  return { w: 3, h: 5, d: 3 };
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
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private unitMeshes = new Map<number, THREE.Object3D>();
  private structureMeshes = new Map<number, THREE.Object3D>();
  private tapMeshes = new Map<string, THREE.Mesh>();
  private relayMeshes = new Map<string, THREE.Mesh>();
  private ghost: THREE.Mesh | null = null;
  private readonly controls: OrbitControls;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0e1116);

    // Perspective + diagonal view so vertical meshes read as 3D (not a flat 2D board).
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
    sc.left = -130;
    sc.right = 130;
    sc.top = 130;
    sc.bottom = -130;
    sc.near = 10;
    sc.far = 320;
    sc.updateProjectionMatrix();
    this.scene.add(sun);

    const groundMat = new THREE.MeshStandardMaterial({ color: 0x1b2430, roughness: 0.92, metalness: 0.04 });
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(220, 220), groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    this.grid = new THREE.GridHelper(200, 40, 0x2a3545, 0x1f2937);
    this.grid.position.y = 0.02;
    this.scene.add(this.grid);

    this.root.add(this.markers, this.entities);
    this.scene.add(this.root);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 48;
    this.controls.maxDistance = 260;
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

  /** Disable while dragging doctrine to the map so the camera does not steal the gesture. */
  setControlsEnabled(enabled: boolean): void {
    this.controls.enabled = enabled;
  }

  /** World XZ from pointer (null if no ground hit). */
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
    this.syncMarkers(state);
    this.syncStructures(state, useGlb);
    this.syncUnits(state, useGlb);
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

  private syncMarkers(state: GameState): void {
    for (const t of state.taps) {
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
      if (t.active && t.yieldRemaining <= 0) mat.color.set(0x888888);
      else if (t.active) mat.color.set(0x3ecf8e);
      else mat.color.set(0x556070);
    }

    const relayPairs: { id: string; x: number; z: number; built: boolean; destroyed: boolean; team: "player" | "enemy" }[] = [
      ...state.playerRelays.map((r) => ({
        id: `p:${r.defId}`,
        x: r.x,
        z: r.z,
        built: r.built && !r.destroyed,
        destroyed: r.destroyed,
        team: "player" as const,
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

    for (const r of relayPairs) {
      let m = this.relayMeshes.get(r.id);
      if (!m) {
        const geo = new THREE.CylinderGeometry(1.2, 1.4, 2.2, 16);
        const mat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.8 });
        m = new THREE.Mesh(geo, mat);
        m.position.y = 1.1;
        m.castShadow = true;
        m.receiveShadow = true;
        this.markers.add(m);
        this.relayMeshes.set(r.id, m);
      }
      m.position.set(r.x, 0, r.z);
      const mat = m.material as THREE.MeshStandardMaterial;
      if (r.team === "player") {
        if (r.built) mat.color.set(0x4da3ff);
        else if (r.destroyed) mat.color.set(0x553333);
        else mat.color.set(0x666666);
      } else {
        mat.color.set(r.built ? 0xff5c5c : 0x444444);
      }
      const s = r.built ? 1 : 0.55;
      m.scale.set(s, s, s);
    }
  }

  private syncStructures(state: GameState, useGlb: boolean): void {
    const alive = new Set(state.structures.map((s) => s.id));
    for (const [id, obj] of this.structureMeshes) {
      if (!alive.has(id)) {
        this.entities.remove(obj);
        obj.traverse((c) => {
          if (c instanceof THREE.Mesh) {
            c.geometry.dispose();
            if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose());
            else c.material.dispose();
          }
        });
        this.structureMeshes.delete(id);
      }
    }

    for (const st of state.structures) {
      let obj = this.structureMeshes.get(st.id);
      if (!obj) {
        const { w, h, d } = structureDims(st.catalogId);
        const geo = new THREE.BoxGeometry(w, h, d);
        const mat = new THREE.MeshStandardMaterial({
          color: st.team === "player" ? 0x6aa6ff : 0xff7a7a,
          roughness: 0.75,
          transparent: true,
          opacity: st.complete ? 1 : 0.55,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.y = h / 2;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const g = new THREE.Group();
        g.userData["placeholder"] = mesh;
        g.add(mesh);
        obj = g;
        this.entities.add(obj);
        this.structureMeshes.set(st.id, obj);
        if (useGlb) {
          const seed = hashStringToSeed(`${st.id}_${st.catalogId}_${st.team}`);
          const target = Math.max(w, h, d) * 1.18;
          void attachGlbFromManifest(seed, mesh, target);
        }
      }
      const g = obj as THREE.Group;
      g.position.set(st.x, 0, st.z);
      const buildT = st.complete ? 1 : 0.35 + 0.65 * (1 - st.buildTicksRemaining / Math.max(1, st.buildTotalTicks));
      g.scale.set(1, buildT, 1);
      const op = st.complete ? 1 : 0.55;
      if (g.userData["glbRoot"]) setGlbOpacity(g, op);
      else {
        const ph = g.userData["placeholder"] as THREE.Mesh;
        const mat = ph.material as THREE.MeshStandardMaterial;
        mat.opacity = op;
        ph.visible = true;
      }
    }
  }

  private syncUnits(state: GameState, useGlb: boolean): void {
    const alive = new Set(state.units.map((u) => u.id));
    for (const [id, obj] of this.unitMeshes) {
      if (!alive.has(id)) {
        this.entities.remove(obj);
        obj.traverse((c) => {
          if (c instanceof THREE.Mesh) {
            c.geometry.dispose();
            if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose());
            else c.material.dispose();
          }
        });
        this.unitMeshes.delete(id);
      }
    }

    for (const u of state.units) {
      let obj = this.unitMeshes.get(u.id);
      if (!obj) {
        const s = unitScale(u.sizeClass);
        const geo = new THREE.BoxGeometry(s, s * 0.85, s);
        const mat = new THREE.MeshStandardMaterial({
          color: u.team === "player" ? 0x8ec5ff : 0xff9b9b,
          roughness: 0.65,
          metalness: 0.05,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.y = s * 0.45;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const g = new THREE.Group();
        g.add(mesh);
        obj = g;
        this.entities.add(obj);
        this.unitMeshes.set(u.id, obj);
        if (useGlb) void requestGlbForSeed(u.visualSeed, mesh);
      }
      obj.position.set(u.x, 0, u.z);
    }
  }

  render(): void {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
