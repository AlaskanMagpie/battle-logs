# Doctrine — Phase 1 playtest (Three.js + Vite)

**Doctrine is the war you draft from broken worlds — then break the next one.**

You are a powerful interdimensional Wizard who defeats armies across the multiverse, lets them return to their peaceful lives, and summons them again when the next fight starts. Some factions sign up for loot and legend. Others are indoctrinated into your doctrine and answer when called.

Doctrine is an action RTS autobattler where cards are the engine of play: draft structures, spells, and commands, drag them onto the battlefield, then override the automatic war when strategy demands it.

Technical package / legacy prototype name: `signal-wars`.

Design reference: **[docs/prd-v2.md](docs/prd-v2.md)** (Vibe Jam PRD v2).

## Run

```bash
npm install
npm run localhost
```

Open **`http://localhost:2222/`** — Vite is configured with `strictPort: true`, so the dev server always uses 2222 or exits with “port in use” (no silent 2223/2224).

`npm run localhost` is the safe local reset path: it closes old listeners on 2222/2223/2224, clears Vite's transform cache, then starts a fresh strict 2222 server. Use `npm run dev` only when you know no stale server is already running.

## Controls (Phase 1)

You command the **blue Wizard** and a doctrine hand of cards.

### Desktop

1. **Move / micro** — **right-click** ground to move the Wizard; with squads selected it also orders them. Hold/drag right-click for follow / formation behavior.
2. **Claim Mana** — walk into a grey node ring and stay inside while the Wizard channels. Claimed nodes add **Mana/sec** and expand cyan **territory**.
3. **Play cards** — drag a Doctrine card from the hand onto valid ground. Structures summon inside territory; spells and commands target directly.
4. **Army stance** — **G** toggles Offense / Defense. Offense pushes objectives; Defense regroups near the Wizard.
5. **Rally / formation** — **R** arms a global rally point. **V** cycles Line / Wedge / Arc for formation orders.
6. **Captain mode** — optional Wizard autopilot. It picks nearby objectives when idle, but manual orders pause it briefly.

### Mobile profile

Doctrine detects coarse-pointer devices and switches to a lighter control profile:

1. **Tap ground** to move the Wizard or attack-move selected squads.
2. **Long-press the map** for simplified orders.
3. **Drag cards** from the doctrine strip to play the war; this is the primary mobile interaction.
4. **Captain mode defaults on**, so the Wizard can auto-battle and claim objectives while you focus on cards.
5. The renderer caps pixel ratio and staggers binder card-preview work to reduce mobile GPU and first-load pressure.

**Win:** shatter the red **Dark Fortresses** or rout the camps.  
**Lose:** your **Keep** or **Wizard** falls.

## Map iteration (`map.local.json`)

Copy `public/map.json` → `public/map.local.json` (same shape) and edit positions. `map.local.json` is **gitignored** so you can iterate without committing. The game loads `map.json` then deep-merges `map.local.json` when present.

## Unit GLBs (Meshy exports)

Meshes live under `public/assets/units/` as `unit_<id>.glb` and are tracked with **Git LFS**. After a fresh clone, run **`git lfs pull`** if models are missing (some GUIs fetch LFS automatically).

- **Default:** GLB art is **on** — units use Meshy GLBs with a stable per-class mapping: manifest indices **0–4** are `Swarm`, `Line`, `Heavy`, `Titan`, and `hero` (see `src/render/glbPool.ts`). Towers map to manifest indices **0–9** by structure catalog id.
- **Cubes only:** add `.env.local` with `VITE_USE_UNIT_GLB=false` and restart the dev server.

`public/assets/units/manifest.json` lists every GLB plus inferred animation profiles. After adding or renaming GLBs, run **`npm run assets:sync-manifest`** to regenerate it from every `*.glb` in that folder. The sync step reads filenames and GLB clip names to group Meshy exports into `run`, `idle`, `attack`, and `death` roles.

If assets start in chat/Downloads, drag them under **`incoming/`** (see `incoming/README.md`) and run **`npm run assets:import-meshy`**. It recursively copies GLBs into `public/assets/units/`, keeps useful source/folder names, then refreshes the manifest. If you only drop files named `Meshy_AI_model.glb`, put each one in a descriptive folder like `frost_heavy_run/` or `ember_swarm_attack/` so the importer has enough context.

Use **`npm run assets:inspect-glbs`** when animation looks wrong. It reports which profiles were inferred, whether files contain skinned meshes/bones, and whether clips have moving bone tracks.

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
