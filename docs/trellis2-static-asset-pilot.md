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

## How to generate assets (free, no GPU, no paid services)

Generation uses the free official HuggingFace Space; everything else runs in-repo.

1. Scripted (preferred):

   ```bash
   npm run assets:trellis -- concept.png rootfort_building
   npm run assets:import-meshy:optimize
   ```

   `scripts/trellis-generate.mjs` uploads the image to the Space, downloads the
   GLB into `incoming/<name>/model.glb`, and enforces the `_building` naming rule.
   Optional `HF_TOKEN` env raises free-tier queue priority. Space APIs drift; if
   the call fails the script prints the live endpoint list — adjust
   `ENDPOINT_CANDIDATES` at the top of the script to match (or use
   `--list-api` to inspect first).

2. Manual fallback: open https://huggingface.co/spaces/microsoft/TRELLIS.2 in a
   browser, upload the image, download the GLB, and drop it into
   `incoming/<name>_building/model.glb` yourself.

For dense outputs, decimate during import with the simplify env vars, e.g.:

```bash
GLTF_SIMPLIFY_ERROR=0.001 npm run assets:import-meshy:optimize
# or target a vertex budget directly:
GLTF_SIMPLIFY_RATIO=0.5 npm run assets:import-meshy:optimize
```

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

The importer's chained `fix-ext-texture-webp` step only touches the files imported in
that run; for a deliberate full-directory repair use `npm run assets:fix-texture-webp`.
The manifest sync also refuses to run when GLBs are Git LFS pointer stubs (fresh clone
without `git lfs pull`) instead of silently wiping animation profiles.

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
