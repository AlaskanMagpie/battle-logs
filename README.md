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

Your starter GLBs are **very large** (~50–140MB each). They live under `public/assets/units/` as `unit_<id>.glb` (gitignored by `*.glb`).

- **Default:** units render with your Meshy GLBs (stable per-class mapping — Swarm/Line/Heavy/Titan/hero always resolve to the same file).
- **To force procedural cubes:** set `VITE_USE_UNIT_GLB=false` in `.env.local` and restart.

`public/assets/units/manifest.json` lists the filenames. The first five entries are used for, in order: `Swarm`, `Line`, `Heavy`, `Titan`, `hero`.

## Copy GLBs into the repo (after clone)

From PowerShell (adjust source path):

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
