/**
 * Scans public/assets/cards/ for image files and writes:
 * - public/assets/cards/manifest.json (runtime fetch URL `/assets/cards/manifest.json`)
 * - src/game/cardArtManifest.bundle.json (same JSON for Vite/TS imports — **do not** import from `public/`)
 *
 * Naming: filename stem must match doctrine catalog id (e.g. watchtower.png → watchtower).
 * Run after adding/replacing card art: npm run assets:sync-cards
 */
import { readdir, writeFile } from "fs/promises";
import { basename, extname, join } from "path";

const ROOT = process.cwd();
const DIR = join(ROOT, "public", "assets", "cards");
const EXTS = new Set([".png", ".webp", ".jpg", ".jpeg", ".svg"]);

let files;
try {
  files = await readdir(DIR);
} catch (e) {
  console.warn("[sync-card-manifest] skip — no public/assets/cards/", e);
  process.exit(0);
}

/** When both `foo.png` and `foo.svg` exist, prefer raster art for binder full-bleed. */
const EXT_PRIORITY = {
  ".png": 0,
  ".webp": 1,
  ".jpg": 2,
  ".jpeg": 2,
  ".svg": 5,
};

const bestById = new Map();
for (const f of files) {
  const ext = extname(f).toLowerCase();
  if (!EXTS.has(ext)) continue;
  const id = basename(f, ext);
  if (!id || id === "manifest") continue;
  const pri = EXT_PRIORITY[ext] ?? 99;
  const prev = bestById.get(id);
  if (!prev || pri < prev.pri) {
    bestById.set(id, { f, pri });
  }
}

const cards = {};
for (const [id, { f }] of bestById) {
  cards[id] = `/assets/cards/${f}`;
}

const out = {
  schemaVersion: 1,
  cards: Object.fromEntries(Object.entries(cards).sort(([a], [b]) => a.localeCompare(b))),
};

const json = JSON.stringify(out, null, 2) + "\n";
await writeFile(join(DIR, "manifest.json"), json, "utf8");
const bundlePath = join(ROOT, "src", "game", "cardArtManifest.bundle.json");
await writeFile(bundlePath, json, "utf8");
console.log(
  `[sync-card-manifest] wrote manifest.json + src/game/cardArtManifest.bundle.json (${Object.keys(cards).length} card art file(s)).`,
);
