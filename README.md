# Signal Wars — Phase 1 playtest (Three.js + Vite)

Design reference: **[docs/prd-v2.md](docs/prd-v2.md)** (Vibejam PRD v2).

## Run

```bash
npm install
npm run dev
```

Open the dev URL (e.g. `http://localhost:2222/` if using the project Vite port).

## Controls (Phase 1)

You play the **blue hero** directly.

1. **Move** — **right-click** ground to move. **Hold right-click** to follow the cursor (MOBA-style).
2. **Claim a Node** — walk onto a grey ring and **stand still**. After a short channel (costs **20 Flux**) it becomes a green, player-owned node that adds **+1 Flux/sec** and expands your cyan **territory**.
3. **Build a Relay** — left-click a blue pillar slot (**slot 1 is free**, then scaling costs; **80 Flux** rebuild after destruction) and pick a **Signal** (Vanguard / Bastion / Reclaim).
4. **Build Towers** — **drag a Doctrine card** from the hand onto the ground *inside your cyan territory*. Towers auto-produce units.
5. **Unit AI** — units push the nearest enemy Relay by default, but **follow the hero** when inside `HERO_FOLLOW_RADIUS`. **Alt+click** a tower to toggle **Hold** on its units.
6. **Rally** — left-click one of your towers, then left-click ground to set its rally.

**Win:** destroy the **enemy Relay** (red pillar) or wipe the **enemy camp**.  
**Lose:** lose all your Relays for **10s** grace (see HUD tick), then defeat.

## Map iteration (`map.local.json`)

Copy `public/map.json` → `public/map.local.json` (same shape) and edit positions. `map.local.json` is **gitignored** so you can iterate without committing. The game loads `map.json` then deep-merges `map.local.json` when present.

## Unit GLBs (Meshy exports)

Meshes live under `public/assets/units/` as `unit_<id>.glb` and are tracked with **Git LFS**. After a fresh clone, run **`git lfs pull`** if models are missing (some GUIs fetch LFS automatically).

- **Default:** GLB art is **on** — units use Meshy GLBs with a stable per-class mapping: manifest indices **0–4** are `Swarm`, `Line`, `Heavy`, `Titan`, and `hero` (see `src/render/glbPool.ts`). Towers map to manifest indices **0–9** by structure catalog id.
- **Cubes only:** add `.env.local` with `VITE_USE_UNIT_GLB=false` and restart the dev server.

`public/assets/units/manifest.json` lists the filenames the loader uses. After adding or renaming GLBs, run **`npm run assets:sync-manifest`** to regenerate it from every `*.glb` in that folder.

If assets start in chat/Downloads, save them under **`incoming/`** (see `incoming/README.md`) and ask Cursor to copy them into `public/assets/units/` — the project rule **chat-assets-ingest** tells the agent to place files and sync the manifest, not only describe usage.

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
