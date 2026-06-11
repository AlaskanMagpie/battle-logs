# TRELLIS.2 static-asset pilot

Goal: evaluate [Microsoft TRELLIS.2](https://github.com/microsoft/TRELLIS.2) (MIT-licensed
image-to-3D, outputs GLB with full PBR materials) as a free complement to Meshy for
**static** assets — structures/towers, Relays, Taps, the Keep, terrain props. TRELLIS.2
does not produce rigs or animation, so spawned units stay on the Meshy workflow.

## Pipeline status (verified)

The existing Meshy pipeline handles static, animation-less GLBs with **zero code
changes**. A synthetic probe (`public/assets/units/trellis_pilot_probe_building.glb`,
built to mimic a TRELLIS.2 output: static mesh + baseColor/metallicRoughness textures)
was run through `npm run assets:import-meshy:optimize` end-to-end:

- imported, Draco-compressed, textures converted to WebP (`EXT_texture_webp`)
- listed in `manifest.json` `files` with no `animationProfiles` entry — same shape as
  the existing tower GLBs (including the benign "No DRACOLoader instance" inspection note)
- served and selectable in `asset-lab.html` ("Browse one GLB" and the doctrine
  "Building GLB" dropdown)

Delete the probe (plus its `manifest.json` entries via `npm run assets:sync-manifest`)
once real TRELLIS.2 assets land.

## How to generate assets

This needs a browser or GPU (the official weights are `microsoft/TRELLIS.2-4B`):

1. Easiest: the official HuggingFace Space — https://huggingface.co/spaces/microsoft/TRELLIS.2 —
   upload an image, download the GLB.
2. Hosted APIs (fal.ai / Replicate-style wrappers) as they pick up TRELLIS.2.
3. ComfyUI with the community TRELLIS.2 nodes on a ≥16GB-VRAM GPU.

Input images: ~1024px+, a single subject on a clean or transparent background, 3/4 view.
Match the diorama art direction — each structure is a *place*: a fort grown into roots,
a driftwood workshop (Relay), an amber conduit pylon (Tap), a keep variant, stump-shrine
terrain props.

## Naming rules (important)

Drop downloads into `incoming/` using descriptive folders, e.g.:

```text
incoming/trellis_rootfort_building/model.glb
incoming/trellis_driftwood_relay_building/model.glb
```

- Names **must end in `_building`**. `towerArtFiles()` in `src/render/glbPool.ts` puts
  every non-animated manifest file into the random in-game tower-art pool unless the
  filename ends with `_building.glb` — without the suffix a new file silently changes
  existing tower visuals.
- Keep the `trellis_` prefix so pilot assets are easy to identify and roll back.
- Avoid animation role tokens (`run`, `idle`, `attack`, `death`, `base`, ...) and unit
  size words (`swarm`, `line`, `heavy`, `titan`, `hero`) in names.

Then:

```bash
npm run assets:import-meshy:optimize
```

Note: the chained `fix-ext-texture-webp` step may rewrite some pre-existing tower GLBs
in place; if you only want to commit the new assets, revert those with
`git checkout -- public/assets/units` (keeping the new `trellis_*` files) and rerun
`npm run assets:sync-manifest`.

## Reviewing

- `npm run dev` → `http://localhost:5173/asset-lab.html` → "Browse one GLB", or assign
  as a structure card's "Building GLB" (localStorage-only, nothing to commit).
- Smallest in-game test: add one line to `TOWER_GLB_OVERRIDES` in `src/render/glbPool.ts`,
  e.g. `watchtower: "trellis_rootfort_building.glb"`. Models auto-scale to
  `TOWER_GLB_TARGET_EXTENT`.
- Map editor (`map-editor.html`) accepts arbitrary GLB uploads for terrain-prop checks.

## Evaluation checklist vs Meshy

- File size after Draco/WebP vs `bastion_keep_compressed.glb` (the optimizer prints
  before/after MB).
- Triangle density via `npm run assets:inspect-glbs` — TRELLIS.2 meshes are voxel-derived
  and can be dense; if 5–10x Meshy counts, consider adding gltf-transform `simplify`.
- PBR under the game's lighting: the renderer uses `NoToneMapping` and no environment
  map, so strongly metallic surfaces will read dark. Judge roughness/opacity instead,
  or treat metalness as something to flatten during optimization.
- Team tint multiplies `material.color` — confirm TRELLIS base-color textures take the
  tint acceptably.
- Orientation, origin (should sit on the ground plane), and scale next to existing towers
  in asset-lab.

## Git LFS

`public/assets/units/*.glb` is LFS-tracked. Run `git lfs install` before committing GLBs
or they will be committed as raw blobs.
