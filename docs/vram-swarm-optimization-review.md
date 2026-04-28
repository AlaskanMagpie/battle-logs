# VRAM Optimization Review for Swarm-Scale Battles

## Goal
Support **very large swarm-vs-swarm battles** with heavy spell/VFX chaos while minimizing VRAM usage and avoiding out-of-memory/perf cliffs.

## What was inspected
- Runtime render path and post-processing in `src/render/scene.ts`.
- GLB loading/caching/animation attach path in `src/render/glbPool.ts`.
- Runtime spell/combat FX lifecycle in `src/render/fx.ts`.
- Resolution / DPR controls in `src/controlProfile.ts`.
- Unit asset manifest and source asset inventory in `public/assets/units/manifest.json` and `public/assets/units/*.glb` (Git LFS pointers in this checkout).

## Key VRAM hotspots (highest impact first)

### 1) Per-instance material cloning for GLB units
In `attachGlbByFile`, every spawned GLB instance clones every mesh material (`cloneInstanceMaterials(inst)`), then applies team tint by mutating colors.

**Why this is expensive:** material cloning scales with unit count and prevents broad material sharing. In big swarms this creates hundreds/thousands of unique material objects and extra GPU state churn.

**Recommendation:**
- Replace per-instance material cloning with **shared team material variants** (e.g., 2 variants per archetype: player/enemy).
- For per-unit variation, move to small per-instance data (instance attributes or uniform palette index), not cloned materials.

### 2) Multiple animation files loaded per class (run + idle + attack + death)
Each class can load separate GLBs for animation roles (`attackFile`, `idleFile`, `deathFile`). Templates are cached, which is good, but total resident animation/template memory grows fast with content breadth.

**Recommendation:**
- Build a **combat preset** with reduced clip set for high-count matches (e.g., only run + attack, drop idle/death clips at distance tiers).
- Author/export a single compact animation container per class with only clips needed for swarm mode.

### 3) Runtime FX allocates and disposes geometry/materials per event
`src/render/fx.ts` spawns many short-lived meshes/lines and disposes them when lifetimes end. This is clean for leaks, but allocation churn can spike memory and fragment heaps during chaos spell bursts.

**Recommendation:**
- Move to **pooled FX primitives** (mesh/line pools by effect type).
- For projectile storms, shift to **GPU particle batches** with shared materials and fixed-cap ring buffers.

### 4) Always-on post-processing render targets (EffectComposer + bloom)
Scene always creates `EffectComposer` + `UnrealBloomPass`. This introduces extra full-resolution render targets that scale with DPR and viewport.

**Recommendation:**
- Add a **Swarm Mode** render profile that disables bloom or runs bloom at reduced internal scale.
- Dynamic bloom kill-switch when unit+spell counts exceed thresholds.

### 5) High-cost sky/background textures and general texture policy
Sky and binder skybox textures are 1024x512; reasonable alone, but with many other textures VRAM can add up. No GPU compressed texture pipeline (KTX2/Basis) is present in runtime path.

**Recommendation:**
- Convert runtime textures to **KTX2 (BasisU)** where possible.
- Use strict texture size tiers by quality profile (especially UI/card art not needed in-match).

## Asset observations from this checkout
All unit `.glb` files in this repo are Git LFS pointers in the current environment (not full binaries). Pointer metadata indicates:
- 30 unit GLBs
- Total referenced source size: ~929 MB
- Largest individual files are very large (many tens to >100 MB), implying high risk for VRAM blowups if those assets are loaded naively.

## Per-unit VRAM scaling model (practical budgeting)
Use this as a first-pass budgeting model for swarm fights:

`Total VRAM ≈ BaseFrameBuffers + SharedAssets + (N_units * PerUnitResident) + ActiveFXBuffers`

Where:
- `BaseFrameBuffers` = swap chain + depth + post FX RTs (depends on resolution/DPR and composer passes).
- `SharedAssets` = unique textures, meshes, skeleton/animation clip data loaded once per archetype.
- `PerUnitResident` = primarily per-instance runtime objects (materials if cloned, skeleton/mixer state, per-unit UI sprites).
- `ActiveFXBuffers` = burst-dependent VFX geometry/material allocations + particle buffers.

### Current code characteristics that make scaling steeper than needed
- Material cloning per GLB instance increases per-unit slope.
- Per-unit label sprites/canvas textures for squad labels and many HP bar planes increase object count.
- FX path alloc/free behavior increases burst-time memory pressure.

## Ranked optimization checklist

## Quick wins (1-3 days)
1. **Add Swarm Mode render profile**
   - Disable bloom or run quarter-res bloom in high-load battles.
   - Expected VRAM savings: **5-20% frame-buffer side** depending on resolution/DPR.
2. **Hard cap active FX by class**
   - Clamp concurrent lightning/impact/decal-like effects.
   - Expected VRAM savings: **high variance**, biggest during spell storms.
3. **Distance-based UI suppression for units**
   - Already partially done (`farCullUi`); push harder: suppress count labels/HP bars sooner in mass scenes.
   - Expected savings: modest VRAM, major draw-call clarity.
4. **Texture compression pipeline start (KTX2 for sky/UI where safe)**
   - Expected VRAM savings: **30-70% texture memory** depending on format/content.

## Medium effort (3-10 days)
1. **Replace per-instance material cloning with shared team variants**
   - Two shared material sets per archetype (player/enemy), no unique clone per unit.
   - Expected VRAM savings: **large at high unit counts**; also reduces state changes.
2. **FX object pooling**
   - Reuse meshes/lines/materials per effect type.
   - Expected savings: less peak memory churn and stabler frametimes.
3. **Animation role reduction in swarm profile**
   - Keep only essential clips for distant units.
   - Expected savings: moderate memory + CPU on mixer updates.

## Deeper architecture (1-4 weeks)
1. **GPU-instanced crowd rendering path**
   - Especially for far/mid LOD units; animation via texture/vertex animation or simplified rigs.
   - Expected savings: very large in both memory overhead and draw calls.
2. **Unified crowd impostor / flipbook LOD tier**
   - Replace far units with billboard/impostor sheets.
   - Expected savings: dramatic for “thousands of units” targets.
3. **GPU particle graph for spell chaos**
   - Ring-buffered particle simulation and batched rendering.
   - Expected savings: large reduction in per-spell object overhead.

## Subsystem-by-subsystem findings

### `src/render/scene.ts`
- Uses capped DPR, no shadows, and has some render-budget logic (good baseline).
- Still pays for composer+bloom render targets in all sessions.
- Maintains many per-unit scene objects (labels/HP bars), which is visually rich but expensive at swarm scale.

### `src/render/glbPool.ts`
- Good template cache and in-flight dedupe.
- Main issue: cloned materials per instance and multi-file animation role attachment.

### `src/render/fx.ts`
- Good explicit disposal and lifetime clamps.
- Main issue: effect creation/disposal model is allocation-heavy under mass concurrent spells.

### `src/controlProfile.ts`
- DPR caps help baseline VRAM/fill-rate.
- Add explicit **combat/swarm adaptive profile** that can be toggled by battle load in real time.

## Stress-test targets (for validation)

Define 3 repeatable scenarios and gate changes on them:

1. **Baseline Swarm**
   - 300 units, low spell rate, 1080p, DPR 1.0
   - Pass: stable VRAM plateau, no growth after 2 minutes.
2. **Chaos Mid**
   - 600 units, sustained spell bursts (20-40 concurrent), 1080p, DPR 1.0
   - Pass: no OOM, no severe spikes when effects overlap.
3. **Chaos Extreme**
   - 1000+ units equivalent via LOD/impostor mix, 60+ concurrent spell effects
   - Pass: predictable VRAM ceiling and graceful quality degradation.

Track per run:
- Peak VRAM
- VRAM at 30s/60s/120s
- # active effects
- # visible units by LOD tier
- FPS p50/p1

## Suggested implementation order
1. Swarm Mode render profile (bloom/RT scaling + stricter UI culling).
2. Shared team material variants (remove per-instance material clone path).
3. FX pooling and active FX caps.
4. Texture compression pipeline (KTX2) for match-critical textures.
5. Crowd LOD architecture (instancing/impostors) for 1000+ targets.

## Risks / caveats
- This environment has LFS pointer files, not full GLB binaries, so exact per-asset GPU memory residency cannot be measured here.
- Savings ranges are estimates; validate with GPU memory capture tooling in your target runtime.
