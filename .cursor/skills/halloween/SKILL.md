---
name: halloween
description: AAA-polish skeletal animation, combat rigging, and VFX workflows for game units. Use when the user says /halloween or asks to improve rigs, Meshy GLBs, T-pose/static frames, foot sliding, run speed matching feet, turn stutter, animation blending, sword swings, fireballs, spell casts, hit impacts, explosions, death/attack/run/idle roles, or skeletal asset import quality.
---

# Halloween

Polish skeletal units, attacks, and spell effects like a gameplay animation/VFX pass, not just an asset import.

## Trigger

Use this skill when the user says `/halloween` or asks for:
- Skeletal/GLB/rig/animation import help.
- T-pose, one-frame pose, static upright frames, bad idle/run/attack/death selection.
- Run speed vs foot cadence matching, foot sliding, turn stutter, animation popping.
- Combat actions described in plain language: "swings his sword", "casts a fireball", "stomps", "breathes flame", "shield bashes".
- Attack trails, cast glows, bloom, projectiles, hit sparks, explosion physics, camera/ground response, and death cleanup.
- Smoother AAA-feeling unit movement, facing, blends, retargeting, or animation QA.

## First Response

If the user says only `/halloween`, or asks to review "everything"/"every model", do a whole-library audit immediately. Do not ask narrow action questions first. Inspect all model/animation assets, classify every file/profile, then recommend broad fixes.

Ask up to 5 questions with `AskQuestion` only when the user names a specific unit/action or the next edit would otherwise be ambiguous. Ask only what is not obvious from files/context.

Default questions:
1. `fantasy`: What should the action read as? Options: sword/melee swing, fireball/spell cast, stomp/slam, breath/beam, summon/aura.
2. `feel`: What feel should this unit have? Options: lumbering titan, soldierly, frantic swarm, floaty/magical, horror/uncanny.
3. `priority`: What should be fixed first? Options: no T-pose/static frames, foot sliding/run speed, turning stutter, attack/VFX timing, death/cleanup.
4. `source`: What assets are available? Options: full GLB set, single model plus clips, only model, existing repo assets, need generated/procedural fallback.
5. `tolerance`: How aggressive can the fix be? Options: preserve authored motion, mild smoothing, strong cinematic smoothing, replace bad clips/add procedural VFX.

If the user is frustrated or wants speed, ask fewer questions and state inferred defaults.

## Invariants

- Never knowingly ship a T-pose/static frame as run, attack, death, or active idle.
- Do not use `Character_output`/one-frame clips as motion unless the user explicitly wants a statue.
- Prefer clips with moving rotation/quaternion tracks for body motion; reject clips with zero moving tracks for active roles.
- Strip or isolate scale tracks that fight class/world normalization.
- Keep authored timing where it sells impact; smooth cadence without changing sim speed.
- Runtime visuals must not affect gameplay simulation timing unless the user requests balance changes.
- Translate plain-language combat intent into readable anticipation, release, travel/contact, impact, and recovery beats.
- If the rig cannot do an action, compensate honestly with runtime VFX/posing/blends; do not claim authored animation exists.
- VFX must serve gameplay readability first: team color, class scale, target direction, hit confirmation, and cleanup.

## Workflow

1. Inspect context:
   - Read the current GLB manifest/tooling, unit renderer, animation-role selection, and relevant catalog/state code.
   - If assets were supplied, copy them into the proper repo asset directory and sync/inspect manifest using existing scripts.
   - Identify model, run, idle, attack, death, and optional turn/strafe candidates.

2. Diagnose clips:
   - Record clip name, duration, track count, moving track count, scale/root-position tracks, skeleton/bone counts.
   - Mark clips as `usable`, `static`, `scale-risk`, `root-motion-risk`, or `wrong-feel`.
   - If no usable clip exists for a role, choose the least bad fallback and make the fallback obvious in code/manifest.

3. Bind roles intentionally:
   - `model`: stable skinned model or best motion file if static model is not suitable.
   - `run`: strongest locomotion clip matching user feel; for titans prefer lumbering walks over sprint loops.
   - `idle`: stance/breath/guard; use slow walk only as a temporary idle fallback.
   - `attack`: clip with visible anticipation/release/follow-through; avoid compressing rich attacks into one pose.
   - `death`: authored death if present; otherwise runtime dissolve/fade with no frozen T-pose.

4. Build combat reads:
   - Map intent to beats:
     - Melee swing: windup pose/turn lock -> weapon trail arc -> contact sparks/slash -> short recoil.
     - Fireball/spell: hand/core charge glow -> projectile with bloom trail -> impact flash/ring -> expanding embers/smoke/knock impulse.
     - Slam/stomp: body anticipation -> downward strike -> ground decal/crack/ring -> dust burst and screen/camera-safe shake.
     - Beam/breath: muzzle anchor -> continuous ribbon/cone -> ticking hit sparks -> fade and residual glow.
   - Attach VFX to stable anchors when bones are available; otherwise use unit bounds/front vector and document the fallback.
   - Time hit VFX to the attack release frame/phase, not attack start, unless the sim only exposes coarse timing.
   - Use bloom/emissive materials sparingly; cap particles/lifetimes so effects read rich without becoming noise.
   - Add lightweight physics reads with existing systems when possible: impulse fields, expanding rings, gravity/fade on motes, ground scorch/cracks.

5. Smooth runtime:
   - Blend run/idle/attack/death with fade windows; do not snap back to stock upright between states.
   - Gate visible movement to locomotion state; if sim position gets ahead, catch up with eased visual interpolation.
   - Face target or move direction continuously; smooth rotation during turns instead of hard snapping.
   - Match run playback to foot cadence: slow frantic short loops, preserve already-heavy walks, and document chosen target duration.
   - During attack turns, keep facing locked to target and avoid upright idle flashes between swings.

6. Asset-side fixes when needed:
   - Rename files so family/role/size inference is unambiguous.
   - Add manifest overrides only when filename/clip inference is insufficient.
   - Clone materials per instance before tint/opacity/dissolve.
   - Normalize visible skinned bounds after mixer setup and clamp only when needed for performance.

## Verification

Run the smallest checks that prove the animation pass:
- Asset diagnostics (`assets:inspect-glbs` or repo equivalent) show expected roles and moving tracks.
- Build/typecheck/tests pass.
- If browser automation is available, capture a short run/turn/attack/spell/death sequence and inspect screenshots/console.
- Confirm no visible T-pose/static upright flash during run, turn, attack recovery, spell cast, or death cleanup.
- Manually report any remaining weak spots: missing death clip, no hand/weapon bone anchor, idle fallback, root motion, foot sliding, over-bright bloom, or browser smoke unavailable.

## Output

When done, summarize:
- Assets used and role mapping.
- Combat/VFX intent mapping: action beats, rig clip, projectile/trail/impact/explosion pieces, timing source.
- What was changed to remove static/T-pose/stutter behavior and improve impact readability.
- Verification commands and results.
- Any animation debt still visible or inferred.
