---
name: unit-animation-audit
description: >-
  Audit produced units for missing or unusable GLB animations: manifest role gaps, orphan pack
  files, zero-motion clips, unrigged motion GLBs, heuristic vs pinned clip selection. Use when
  the user says missing animation, T-pose, frozen run, no death, swarm audit, Wizard Keep swarm,
  geode monks, or wants a checklist before rebaking or rewiring assets.
disable-model-invocation: true
---

# Unit animation audit

**Goal:** Decide if a unit’s problem is **missing file / missing clip / zero motion / wrong pick / doctrine donor** — before re-exporting or merging.

**Invariants:** `UnitAnimationRole` = `model` | `run` | `idle` | `attack` | `death` ([`src/render/glbPool.ts`](../../../src/render/glbPool.ts)). Runtime: `attachGlbByFile` warns `[glb] ... missing animation roles` and `[glb] ... no usable runtime rig/animation` (search file for `warnedAnimationRoles`).

## When to use

- In-match or Asset Lab: no run/idle/attack/death, snaps, or silent failures.
- User names a **structure** (“Wizard Keep”), **flavor** (“geode dudes”), or **stem** (`azure_spear_swarm`).

## Checklist (ordered)

1. **Resolve `producedUnitId` (do not guess filenames)**  
   - Grep [`src/game/catalog.ts`](../../../src/game/catalog.ts) for structure / flavor → `producedUnitId`.  
   - Confirm string in [`src/game/constants.ts`](../../../src/game/constants.ts) (`PRODUCED_UNIT_*`).

2. **Pick the combat profile**  
   - In [`public/assets/units/manifest.json`](../../../public/assets/units/manifest.json), `animationProfiles[]` where `id === producedUnitId` (exact).  
   - If a sibling exists (`*_character`, model-only), **ignore** it for motion gaps — audit the profile that defines `run` / `idle` / `attack` / `death`.

3. **Manifest static pass**  
   - Each `roles.*` value must appear in `manifest.files`.  
   - **Orphans:** entries in `profile.files[]` not used as any `roles.*` value → unused pack member (rewire, merge, or delete intentionally).

4. **CLI clip inventory**  
   ```bash
   npm run assets:inspect-glbs:profile -- <producedUnitId>
   ```  
   Multi-stem union: `npm run assets:inspect-glbs:only -- <pattern>`. Scripts: [`scripts/inspect-unit-glbs.mjs`](../../../scripts/inspect-unit-glbs.mjs).

5. **Interpret inspect lines**  
   - `no clips` on a **role** GLB → hard miss (bake or add clip).  
   - All clips `movingTracks=0` on a locomotion/attack file → likely rejected (runtime avoids dead motion; history in [`progress.md`](../../../progress.md)).  
   - `skinned=0` / `bones=0` on a file used as motion → matches `[glb] ... no usable runtime rig/animation`.

6. **Heuristic vs pinned**  
   - Selection logic: [`clipForRole`](../../../src/render/glbPool.ts) (merged packs, Starbound hero, explicit non-merged doctrine names). If clips exist but look wrong → **wrong pick**, not missing file: Asset Lab + doctrine string or rename/remerge. Keyword tables: [animations skill](../animations/SKILL.md).

7. **Doctrine-only bugs**  
   - If repro needs a binder: grep doctrine / `quickMatchDoctrine` for `stem — clip`; parse with [`src/game/doctrineClipRef.ts`](../../../src/game/doctrineClipRef.ts); verify `donorFile` ∈ `manifest.files` and inspect shows that clip name.

8. **Optional runtime**  
   - Spawn unit with devtools console: `[glb]` warnings dedupe per key — clear cache / new session if you need a repeat.

## Worked examples

- **Wizard Keep / Cragrunner (acrobat swarm):** `PRODUCED_UNIT_ACROBAT_WARRIOR_SCOUTS` → `azure_spear_swarm`. Inspect profile; `roles` split across `azure_spear_swarm_*.glb`. Extra files in `files[]` (e.g. `*_idle.glb` vs `idle` → `*_walking.glb`) → orphan or intentional; compare to `AZURE_SPEAR_SWARM_*` constants in `glbPool.ts` if investigating wrong-clip routing.

- **Amber Geode Monks:** Motion profile `amber_geode_monks` (run/walk/attack/death files). Static/hero mesh: `amber_geode_monks_character` (`model` only) — do not conflate when auditing combat motion.

## After fixes

- New/changed GLBs: `npm run assets:sync-manifest` ([`scripts/sync-unit-manifest.mjs`](../../../scripts/sync-unit-manifest.mjs)). Re-run inspect profile.
