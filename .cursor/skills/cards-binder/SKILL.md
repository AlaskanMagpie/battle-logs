---
name: cards-binder
description: >-
  Runs and owns the doctrine binder TCG card pipeline: sync public/assets/cards/manifest.json,
  bump cache buster when art set changes, verify tests. Use when adding or renaming card art under
  public/assets/cards/, fixing full-bleed binder sleeves, doctrine picker card previews, or
  src/ui/cardArtManifest.ts / binderCardTexture / DoctrineBinderPicker. Agent must execute
  npm run cards:pipeline (not only describe it).
---

# Cards + doctrine binder (execute, don’t only document)

## Mandatory command

After **any** change to files under `public/assets/cards/` (add/rename/replace image), or when fixing binder manifest/cache behavior, **run from repo root**:

```bash
npm run cards:pipeline
```

That script **does**: regenerate `manifest.json` → **bump** `CARD_ART_CACHE_BUSTER` in `src/ui/cardArtManifest.ts` **if** the card map changed → run `vitest` on `src/game/doctrineBinderCatalog.test.ts`.

Do **not** leave the task at “you should run sync” — **run** `npm run cards:pipeline` and report exit code + relevant log lines.

- To regenerate manifest **without** bumping cache (rare): `CARDS_PIPELINE_NO_BUMP=1 npm run cards:pipeline` on Unix; on Windows PowerShell: `$env:CARDS_PIPELINE_NO_BUMP=1; npm run cards:pipeline`
- Full ship check still expects **`npm run build`** (includes sync + `vite build`).

## Naming (failure mode #1)

- Card files: **`public/assets/cards/{catalogId}.{ext}`** — stem **must** match `entry.id` in `src/game/catalog.ts` (e.g. Rootbound Crag → `bastion_keep.png`), **not** display title.
- Allowed extensions: `.png`, `.webp`, `.jpg`, `.jpeg`, `.svg` (see `scripts/sync-card-manifest.mjs`).
- **Duplicate stems:** if both `watchtower.png` and `watchtower.svg` exist, sync **prefers** `.png` > `.webp` > `.jpg`/`.jpeg` > `.svg` so final art wins over placeholders.

## Runtime behavior (know what you’re fixing)

- Full-bleed sleeve art loads via `getCardArtUrl` → `src/ui/cardArtManifest.ts`. Production uses **`manifest.json`**; dev may probe missing ids with `HEAD` (see same file).
- `DoctrineBinderPicker` calls `resetCardArtManifestCache()` on mount so manifest JSON isn’t stuck.
- Binder textures cache key includes `CARD_ART_CACHE_BUSTER` — if art looks stale after a bump, hard refresh.

## Confusion to avoid

- **`public/assets/units/*.glb`** = battlefield units; **`npm run assets:sync-manifest`** — separate from cards.
- HUD GLB previews (`cardGlbPreview`) may still use `/assets/cards/` when present — card pipeline keeps both aligned.

## Agent checklist (copy)

1. Place or rename images under `public/assets/cards/` using **exact** catalog ids.
2. Run **`npm run cards:pipeline`**.
3. If changing logic only (no new files), run **`npm test`** or targeted vitest as needed.
4. Mention whether cache buster incremented (pipeline logs it when manifest card map changes).
