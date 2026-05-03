# Animations skill — reference (Meshy / exports)

## Typical failure mode

Tools and exporters often emit **generic** `AnimationClip` names. Asset Lab and `guessUnitClipsFromNames` only see **names**, not thumbnails. After `gltf-transform optimize` (Draco / WebP), names are usually preserved; if they look wrong, the **source** often already had empty or duplicate names — compression just forced you to look.

## Meshy-leaning folders (import script)

[`scripts/import-meshy-assets.mjs`](../../../scripts/import-meshy-assets.mjs) renames `meshy*.glb` / `model.glb` / `scene.glb` from the **parent folder** name. Clip **internal** names are unchanged — so the **filename** may look great while clip rows in Asset Lab still say `Animation`.

## Practical naming (upstream)

When you control export: give each action a **distinct clip name** containing a role keyword (`run`, `idle`, `attack`, `death`, etc.) so keyword guessing works without heuristics.

## gltf-transform (optional rename)

If clips are structurally correct but poorly named, renaming in the glTF **before** game import is preferable to guessing forever. Use the project’s existing `@gltf-transform/cli` dependency; exact rename steps depend on clip/channel layout — prefer re-export from DCC/Meshy with named actions when possible.
