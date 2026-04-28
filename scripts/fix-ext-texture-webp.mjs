/**
 * Repairs glTF 2.0 GLBs that use image/webp on the core texture.source path (invalid
 * without EXT_texture_webp). Rewrites to EXT_texture_webp "WebP-only" layout and
 * registers extensionsUsed / extensionsRequired. Three.js GLTFLoader supports this.
 *
 * Usage:
 *   node scripts/fix-ext-texture-webp.mjs [--dry-run] [path.glb|dir ...]
 * Defaults to scanning all .glb files under public/ recursively when no paths are given.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

const EXT_WEBP = "EXT_texture_webp";

function paddingBytes(chunkDataLen) {
  return (4 - (chunkDataLen % 4)) % 4;
}

/** @returns {{ type: number, data: Buffer }[]} */
function readChunks(buffer) {
  const magic = buffer.readUInt32LE(0);
  if (magic !== GLB_MAGIC) throw new Error("Not a GLB (bad magic)");
  const version = buffer.readUInt32LE(4);
  if (version !== GLB_VERSION) throw new Error(`Unsupported GLB version ${version}`);
  let o = 12;
  const chunks = [];
  while (o < buffer.length) {
    const len = buffer.readUInt32LE(o);
    const type = buffer.readUInt32LE(o + 4);
    const start = o + 8;
    const data = Buffer.from(buffer.subarray(start, start + len));
    chunks.push({ type, data });
    o = start + len + paddingBytes(len);
  }
  return chunks;
}

/** @param {{ type: number, data: Buffer }[]} chunks */
function writeChunks(chunks) {
  const parts = [];
  for (const c of chunks) {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(c.data.length, 0);
    head.writeUInt32LE(c.type, 4);
    parts.push(head, c.data, Buffer.alloc(paddingBytes(c.data.length), 0x20));
  }
  return Buffer.concat(parts);
}

function buildGlb(jsonChunkData, otherChunks) {
  const body = writeChunks([{ type: CHUNK_JSON, data: jsonChunkData }, ...otherChunks]);
  const total = 12 + body.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(GLB_VERSION, 4);
  header.writeUInt32LE(total, 8);
  return Buffer.concat([header, body]);
}

function addUnique(arr, name) {
  if (!arr.includes(name)) arr.push(name);
}

/**
 * @param {Record<string, unknown>} gltf
 * @returns {boolean} true if JSON was modified
 */
function patchGltfJson(gltf) {
  const images = gltf.images;
  if (!Array.isArray(images)) return false;

  const textures = gltf.textures;
  if (!Array.isArray(textures)) return false;

  let dirty = false;

  for (const tex of textures) {
    if (!tex || typeof tex !== "object") continue;
    if (tex.extensions && typeof tex.extensions === "object" && EXT_WEBP in tex.extensions) continue;
    const src = tex.source;
    if (typeof src !== "number") continue;
    const img = images[src];
    if (!img || typeof img !== "object") continue;
    const mime = typeof img.mimeType === "string" ? img.mimeType.toLowerCase() : "";
    if (mime !== "image/webp") continue;

    const idx = src;
    delete tex.source;
    if (!tex.extensions || typeof tex.extensions !== "object") tex.extensions = {};
    tex.extensions[EXT_WEBP] = { source: idx };
    dirty = true;
  }

  if (!dirty) return false;

  if (!gltf.extensionsUsed || !Array.isArray(gltf.extensionsUsed)) gltf.extensionsUsed = [];
  if (!gltf.extensionsRequired || !Array.isArray(gltf.extensionsRequired)) gltf.extensionsRequired = [];
  addUnique(gltf.extensionsUsed, EXT_WEBP);
  addUnique(gltf.extensionsRequired, EXT_WEBP);

  return true;
}

/**
 * @param {Buffer} input
 * @returns {{ out: Buffer, changed: boolean, error?: string }}
 */
function repairGlbBuffer(input) {
  try {
    const chunks = readChunks(input);
    const jsonChunk = chunks.find((c) => c.type === CHUNK_JSON);
    if (!jsonChunk) return { out: input, changed: false, error: "No JSON chunk" };
    const jsonText = jsonChunk.data.toString("utf8");
    const gltf = JSON.parse(jsonText);
    if (!patchGltfJson(gltf)) return { out: input, changed: false };
    const jsonBuf = Buffer.from(JSON.stringify(gltf), "utf8");
    const other = chunks.filter((c) => c.type !== CHUNK_JSON);
    const out = buildGlb(jsonBuf, other);
    return { out, changed: true };
  } catch (e) {
    return { out: input, changed: false, error: String(e) };
  }
}

function collectGlbsFromPaths(paths) {
  /** @type {string[]} */
  const out = [];
  for (const p of paths) {
    const abs = path.isAbsolute(p) ? p : path.join(repoRoot, p);
    if (!fs.existsSync(abs)) continue;
    const st = fs.statSync(abs);
    if (st.isFile() && abs.toLowerCase().endsWith(".glb")) out.push(abs);
    else if (st.isDirectory()) out.push(...walkGlbs(abs));
  }
  return [...new Set(out)];
}

function walkGlbs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkGlbs(full));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".glb")) out.push(full);
  }
  return out;
}

function defaultPublicGlbs() {
  const publicDir = path.join(repoRoot, "public");
  if (!fs.existsSync(publicDir)) return [];
  return walkGlbs(publicDir);
}

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const paths = argv.filter((a) => a !== "--dry-run");

const files = paths.length ? collectGlbsFromPaths(paths) : defaultPublicGlbs();
if (!files.length) {
  console.log("[fix-ext-texture-webp] No GLB files to scan.");
  process.exit(0);
}

let fixed = 0;
let skipped = 0;
let errors = 0;

for (const abs of files.sort()) {
  const rel = path.relative(repoRoot, abs);
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch (e) {
    console.error(`[fix-ext-texture-webp] read failed ${rel}:`, e);
    errors++;
    continue;
  }
  const { out, changed, error } = repairGlbBuffer(buf);
  if (error) {
    console.warn(`[fix-ext-texture-webp] ${rel}: ${error}`);
    errors++;
    continue;
  }
  if (!changed) {
    skipped++;
    continue;
  }
  console.log(`${dryRun ? "[dry-run] " : ""}fix ${rel}`);
  if (!dryRun) fs.writeFileSync(abs, out);
  fixed++;
}

console.log(
  `[fix-ext-texture-webp] done: fixed=${fixed} unchanged_or_ok=${skipped} errors=${errors}${dryRun ? " (dry-run)" : ""}`,
);
process.exit(errors > 0 ? 1 : 0);
