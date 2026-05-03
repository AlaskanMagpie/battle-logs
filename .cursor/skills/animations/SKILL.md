---
name: animations
description: >-
  Enumerates unit GLB animation clips, maps them to run/idle/attack/die using the same
  keyword rules as Asset Lab doctrine guessing, and uses inspect-script heuristics when
  names are generic or post-compression. Use when the user says /animations or @animations,
  names a catalog id or unit GLB, reports Asset Lab clip dropdowns wrong after optimize,
  or wants batch unit animation verification without paid APIs.
disable-model-invocation: true
---

# Animations (`/animations`) — clip inventory and doctrine readiness

## Goal

Produce a **clip roster + role mapping** for a unit (or profile) so Asset Lab doctrine can be set quickly. Default path is **CLI inspect** (no browser). Visual checks only when names and motion stats disagree.

## Commands (execute from repo root)

| Task | Command |
|------|---------|
| Full manifest | `npm run assets:inspect-glbs` |
| One stem / filename pattern | `npm run assets:inspect-glbs:only -- <pattern>` |
| One `animationProfiles[].id` | `npm run assets:inspect-glbs:profile -- <profileId>` |

Patterns: substring match on basename (case-insensitive). If the pattern contains `*` or `?`, it is treated as a glob against the **filename** (e.g. `lanternbound_line_*.glb`).

Implementation: [`scripts/inspect-unit-glbs.mjs`](../../../scripts/inspect-unit-glbs.mjs). Uses Three.js GLTFLoader — same clip names Asset Lab shows (merged labels use `stem — clip.name` in [`src/dev/assetLab.ts`](../../../src/dev/assetLab.ts)).

## Workflow

1. **Resolve scope**
   - If the user gives **`animationProfiles[].id`**: run `assets:inspect-glbs:profile -- <id>` (exact id; if no hit, substring match on profile ids — if multiple profiles match, list them and inspect all unioned files).
   - If they give a **filename stem** (e.g. `verdant_gatekeeper_titan`): run `assets:inspect-glbs:only -- <stem>`.
   - Else run full `assets:inspect-glbs` (heavy).

2. **Read inspect lines**  
   Each clip: `name`, `duration`, `movingTracks` (bones with animated position/rotation that actually change over the clip).

3. **Map roles — match game logic first**  
   Use the **same keyword lists** as [`guessUnitClipsFromNames`](../../../src/game/assetLabDoctrine.ts) (first clip whose **lower** name includes any keyword):

   | Role | Keywords |
   |------|----------|
   | run | running, run, sprint, jog, move |
   | idle | idle, stand, breath, stance, combat |
   | attack | attack, slash, strike, swing, cast, combo, charge |
   | die | die, death, dead, knock, dying |

   For **merged** Asset Lab labels, keywords apply to the **full** dropdown string (`stem — clip.name`) unless you reason on raw `clip.name` only — substring match still works if the stem contains e.g. `running`.

4. **When names are useless** (empty, `Animation`, `Take 001`, duplicates)  
   Use **free signals** from inspect output only (no paid APIs):
   - **die**: often shortest among action clips; sometimes fewer `movingTracks` if collapse pose.
   - **idle**: often **low** `movingTracks` vs run; longer duration loop.
   - **run**: higher `movingTracks`, loop-friendly duration.
   - **attack**: medium–high motion, non-loop feel (duration often shorter than idle/run — not universal).
   - If several clips tie, mark **ambiguous** and recommend Asset Lab preview or Playwright (use the user’s **playwright** Codex skill if they want scripted browser checks) for that clip only.

5. **Deliverable — paste this table for the user**

```markdown
## Clips: <unit or profile id>

| File | Clip name (raw) | Duration | movingTracks | Suggested role | Notes |
|------|-----------------|----------|----------------|----------------|-------|
| … | … | …s | … | run / idle / attack / die / ? | keyword / heuristic / ambiguous |

**Asset Lab dropdown values** (if merged): use exact strings `stem — clip.name` (filename stem plus separator plus raw clip name from inspect).

**Doctrine**: set in Asset Lab or merge JSON per [doctrine skill](../doctrine/SKILL.md). Clip names in saved `unitClips` must match those dropdown strings.
```

6. **After optimize / import**  
   Re-run inspect for the same files. If names worsened, fix **upstream** (re-export, or rename animations before optimize). Pipeline scripts: [`scripts/optimize-glb.mjs`](../../../scripts/optimize-glb.mjs), [`scripts/import-meshy-assets.mjs`](../../../scripts/import-meshy-assets.mjs). Rig polish (not naming): [halloween skill](../halloween/SKILL.md).

## Extra context

- Meshy / export naming habits: [reference.md](reference.md)

## Verification

Compare inspect clip **names + counts** to Asset Lab’s unit clip dropdown for the same assigned GLB(s).
