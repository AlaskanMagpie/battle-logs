/**
 * Scans public/assets/cards/ for image files and writes manifest.json:
 *   { "catalog_id": "/assets/cards/catalog_id.png", ... }
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

await writeFile(join(DIR, "manifest.json"), JSON.stringify(out, null, 2) + "\n", "utf8");
console.log(`[sync-card-manifest] wrote manifest.json (${Object.keys(cards).length} card art file(s)).`);
