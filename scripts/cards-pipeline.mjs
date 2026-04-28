/**
 * Doctrine binder card art pipeline (run via npm run cards:pipeline):
 * 1. Regenerate public/assets/cards/manifest.json from files on disk.
 * 2. If the manifest's card map changed, bump CARD_ART_CACHE_BUSTER in src/ui/cardArtManifest.ts
 *    so browsers refetch JSON and assets (skip with CARDS_PIPELINE_NO_BUMP=1).
 * 3. Run binder-related unit tests.
 */
import { execSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFEST_PATH = join(ROOT, "public", "assets", "cards", "manifest.json");
const CARD_ART_TS = join(ROOT, "src", "ui", "cardArtManifest.ts");

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

const beforeFp = cardsFingerprint();

execSync("node scripts/sync-card-manifest.mjs", { stdio: "inherit", cwd: ROOT });

const afterFp = cardsFingerprint();

const skipBump = process.env.CARDS_PIPELINE_NO_BUMP === "1" || process.env.CARDS_PIPELINE_NO_BUMP === "true";
if (!skipBump && beforeFp !== afterFp) {
  bumpCardArtCacheBuster();
} else if (skipBump && beforeFp !== afterFp) {
  console.log("[cards-pipeline] manifest changed but CARDS_PIPELINE_NO_BUMP set — did not bump cache buster");
}

execSync("npx vitest run src/game/doctrineBinderCatalog.test.ts", { stdio: "inherit", cwd: ROOT });

console.log("[cards-pipeline] done.");
