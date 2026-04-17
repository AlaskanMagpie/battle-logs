# Signal Wars — Phase 1 playtest (Three.js + Vite)

Design reference: **[docs/prd-v2.md](docs/prd-v2.md)** (Vibejam PRD v2).

## Run

```bash
npm install
npm run dev
```

Open the dev URL (e.g. `http://localhost:2222/` if using the project Vite port).

## Controls (Phase 1)

1. **Activate Tap** — click a grey ring (costs **80 Flux**). Green ring = active; grey ring when yield depleted.
2. **Build Relay** — click a short grey pillar near your start (**slot 1 is free**, then costs match the PRD table; **80 Flux** rebuild after destruction).
3. **Doctrine** — click slots **1–3** (Watchtower / Root Bunker / Mender’s Hut), then click the ground **near an active Tap or built Relay** to place.
4. **Rally** — click one of your structures, then click the ground to set its rally point (new units path toward it while fighting).

**Win:** destroy the **enemy Relay** (red pillar) or wipe the **enemy camp**.  
**Lose:** lose all your Relays for **10s** grace (see HUD tick), then defeat.

## Map iteration (`map.local.json`)

Copy `public/map.json` → `public/map.local.json` (same shape) and edit positions. `map.local.json` is **gitignored** so you can iterate without committing. The game loads `map.json` then deep-merges `map.local.json` when present.

## Unit GLBs (Meshy exports)

Meshes live under `public/assets/units/` as `unit_<id>.glb` and are tracked with **Git LFS**. After a fresh clone, run **`git lfs pull`** if models are missing (some GUIs fetch LFS automatically).

- **Default:** GLB art is **on** — each new unit async-loads from `manifest.json` (first paint can take a moment on slow disks).
- **Cubes only:** add `.env.local` with `VITE_USE_UNIT_GLB=false` and restart the dev server.

`public/assets/units/manifest.json` lists the filenames the loader uses.

## Copy GLBs from Meshy export folders (optional)

Use this when you have Meshy output on disk and want to refresh `public/assets/units/` (filenames must still match `manifest.json`, or update the manifest). From PowerShell (adjust source path):

```powershell
$base = "C:\path\to\Meshy_AI_assets_...\..."
New-Item -ItemType Directory -Force "public\assets\units" | Out-Null
Get-ChildItem $base -Directory | ForEach-Object {
  $glb = Join-Path $_.FullName "Meshy_AI_model.glb"
  if (Test-Path $glb) {
    Copy-Item -Force $glb (Join-Path "public\assets\units" ("unit_" + $_.Name + ".glb"))
  }
}
```
