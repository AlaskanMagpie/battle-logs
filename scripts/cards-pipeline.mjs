/**
 * Doctrine binder card art pipeline (run via npm run cards:pipeline):
 * 1. Regenerate public/assets/cards/manifest.json from files on disk.
 * 2. If the manifest's card map **or** any card image bytes changed since last run, bump
 *    CARD_ART_CACHE_BUSTER in src/ui/cardArtManifest.ts so browsers and binder textures
 *    refetch fresh art (skip with CARDS_PIPELINE_NO_BUMP=1).
 * 3. Warn if raster card files under public/assets/cards are not exactly 400×600 (2:3, matches
 *    tcgCardPrint). CARDS_PIPELINE_STRICT_CARD_SIZE=1 fails the run; CARDS_PIPELINE_SKIP_PRINT_SIZE=1 skips.
 * 4. Run binder-related unit tests.
 */
import { execSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { dirname, extname, join } from "path";
import sharp from "sharp";
import { fileURLToPath } from "url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFEST_PATH = join(ROOT, "public", "assets", "cards", "manifest.json");
const CARD_ART_TS = join(ROOT, "src", "ui", "cardArtManifest.ts");
const LAST_ASSET_FP = join(ROOT, "scripts", "last-card-assets.sha256");

const CARD_ART_EXTS = new Set([".png", ".webp", ".jpg", ".jpeg", ".svg"]);

/** SHA-256 of sorted card art file names + raw bytes (re-saving SVG/PNG in place bumps this). */
function cardArtFilesFingerprint() {
  const dir = join(ROOT, "public", "assets", "cards");
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir)
    .filter((f) => CARD_ART_EXTS.has(extname(f).toLowerCase()))
    .sort();
  const h = createHash("sha256");
  for (const f of names) {
    const p = join(dir, f);
    h.update(f);
    h.update(readFileSync(p));
  }
  return h.digest("hex");
}

function cardsFingerprint() {
  if (!existsSync(MANIFEST_PATH)) return null;
  try {
    const raw = readFileSync(MANIFEST_PATH, "utf8");
    const j = JSON.parse(raw);
    const cards = j.cards && typeof j.cards === "object" ? j.cards : {};
    return createHash("sha256").update(JSON.stringify(cards)).digest("hex");
  } catch {
    return null;
  }
}

function bumpCardArtCacheBuster() {
  let src = readFileSync(CARD_ART_TS, "utf8");
  const re = /export const CARD_ART_CACHE_BUSTER = "(\d+)"/;
  const m = src.match(re);
  if (!m) {
    console.warn("[cards-pipeline] could not find CARD_ART_CACHE_BUSTER in cardArtManifest.ts — skip bump");
    return;
  }
  const next = String(Number(m[1], 10) + 1);
  src = src.replace(re, `export const CARD_ART_CACHE_BUSTER = "${next}"`);
  writeFileSync(CARD_ART_TS, src, "utf8");
  console.log(`[cards-pipeline] bumped CARD_ART_CACHE_BUSTER → ${next}`);
}

/** Must match `TCG_FULL_CARD_W` / `TCG_FULL_CARD_H` in `src/ui/tcgCardPrint.ts` (2:3 print doctrine cards). */
const PRINT_CARD_W = 400;
const PRINT_CARD_H = 600;
const PRINT_DIM_EXTS = new Set([".png", ".webp", ".jpg", ".jpeg"]);

async function verifyDoctrineCardPrintDimensions() {
  if (process.env.CARDS_PIPELINE_SKIP_PRINT_SIZE === "1" || process.env.CARDS_PIPELINE_SKIP_PRINT_SIZE === "true") {
    console.log("[cards-pipeline] skipping print size check (CARDS_PIPELINE_SKIP_PRINT_SIZE)");
    return;
  }
  const dir = join(ROOT, "public", "assets", "cards");
  if (!existsSync(dir)) return;
  const bad = [];
  for (const f of readdirSync(dir)) {
    const ext = extname(f).toLowerCase();
    if (!PRINT_DIM_EXTS.has(ext)) continue;
    const p = join(dir, f);
    try {
      const m = await sharp(p).metadata();
      if (m.width !== PRINT_CARD_W || m.height !== PRINT_CARD_H) {
        bad.push(`${f} (${m.width ?? "?"}×${m.height ?? "?"})`);
      }
    } catch (e) {
      bad.push(`${f} (${e?.message ?? "metadata failed"})`);
    }
  }
  if (!bad.length) return;
  const msg = `[cards-pipeline] doctrine card rasters should be ${PRINT_CARD_W}×${PRINT_CARD_H} (2:3, matches src/ui/tcgCardPrint.ts). Off:\n  - ${bad.join("\n  - ")}\nSet CARDS_PIPELINE_STRICT_CARD_SIZE=1 to fail the run, or CARDS_PIPELINE_SKIP_PRINT_SIZE=1 to silence.`;
  if (process.env.CARDS_PIPELINE_STRICT_CARD_SIZE === "1") {
    console.error(msg);
    process.exit(1);
  }
  console.warn(msg);
}

const beforeManifestFp = cardsFingerprint();
const beforeAssetFp = cardArtFilesFingerprint();

execSync("node scripts/sync-card-manifest.mjs", { stdio: "inherit", cwd: ROOT });

const afterManifestFp = cardsFingerprint();
const afterAssetFp = cardArtFilesFingerprint();
const prevStoredAssetFp = existsSync(LAST_ASSET_FP) ? readFileSync(LAST_ASSET_FP, "utf8").trim() : null;

const manifestChanged = beforeManifestFp !== afterManifestFp;
const assetsChangedSinceLastRun =
  afterAssetFp != null && prevStoredAssetFp != null && prevStoredAssetFp !== afterAssetFp;
const needBaselineFingerprintFile = afterAssetFp != null && prevStoredAssetFp === null;

const skipBump = process.env.CARDS_PIPELINE_NO_BUMP === "1" || process.env.CARDS_PIPELINE_NO_BUMP === "true";
if (!skipBump && (manifestChanged || assetsChangedSinceLastRun)) {
  bumpCardArtCacheBuster();
  if (afterAssetFp) writeFileSync(LAST_ASSET_FP, `${afterAssetFp}\n`, "utf8");
  if (manifestChanged) console.log("[cards-pipeline] manifest card map changed");
  if (assetsChangedSinceLastRun) console.log("[cards-pipeline] card image bytes changed (includes re-save in place)");
} else if (skipBump && (manifestChanged || assetsChangedSinceLastRun)) {
  console.log("[cards-pipeline] art/manifest changed but CARDS_PIPELINE_NO_BUMP set — did not bump cache buster");
} else if (needBaselineFingerprintFile) {
  writeFileSync(LAST_ASSET_FP, `${afterAssetFp}\n`, "utf8");
  console.log("[cards-pipeline] wrote scripts/last-card-assets.sha256 (baseline for future byte-level bumps)");
}

await verifyDoctrineCardPrintDimensions();

execSync("npx vitest run src/game/doctrineBinderCatalog.test.ts", { stdio: "inherit", cwd: ROOT });

console.log("[cards-pipeline] done.");
