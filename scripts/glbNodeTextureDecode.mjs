/**
 * Node-side GLB prep for THREE.GLTFLoader.parse: decodes EXT_texture_webp to embedded PNG
 * so inspection scripts work without a browser `Image` implementation.
 */
import { NodeIO } from "@gltf-transform/core";
import { EXTTextureWebP } from "@gltf-transform/extensions";
import { textureCompress } from "@gltf-transform/functions";
import sharp from "sharp";

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const EXT_TEXTURE_WEBP = "EXT_texture_webp";
const KHR_DRACO = "KHR_draco_mesh_compression";

/**
 * WebP-only decode for Node THREE.parse. Skip when Draco is also required — gltf-transform would
 * need Draco WASM; those assets already load in the browser and sync uses THREE for them.
 * @param {Buffer} buffer
 */
export function glbJsonUsesRequiredTextureWebp(buffer) {
  try {
    const json = extractJsonChunk(buffer);
    const req = json?.extensionsRequired;
    if (!Array.isArray(req) || !req.includes(EXT_TEXTURE_WEBP)) return false;
    if (req.includes(KHR_DRACO)) return false;
    return true;
  } catch {
    return false;
  }
}

/** @param {Buffer} buffer */
function extractJsonChunk(buffer) {
  const magic = buffer.readUInt32LE(0);
  if (magic !== GLB_MAGIC) throw new Error("Not a GLB (bad magic)");
  let o = 12;
  while (o < buffer.length) {
    const len = buffer.readUInt32LE(o);
    const type = buffer.readUInt32LE(o + 4);
    const start = o + 8;
    if (type === CHUNK_JSON) {
      return JSON.parse(buffer.subarray(start, start + len).toString("utf8"));
    }
    const pad = (4 - (len % 4)) % 4;
    o = start + len + pad;
  }
  throw new Error("No JSON chunk in GLB");
}

let ioPromise = null;

async function getIo() {
  if (!ioPromise) {
    ioPromise = (async () => {
      // Only vendor WebP — avoid ALL_EXTENSIONS (Draco needs decoder WASM in Node).
      const io = new NodeIO().registerExtensions([EXTTextureWebP]);
      await io.init();
      return io;
    })();
  }
  return ioPromise;
}

/** @param {Buffer} buffer @returns {Promise<Buffer>} */
export async function decodeTextureWebpToPngGlb(buffer) {
  const io = await getIo();
  const doc = await io.readBinary(new Uint8Array(buffer));
  await doc.transform(textureCompress({ encoder: sharp, targetFormat: "png" }));
  const out = await io.writeBinary(doc);
  return Buffer.from(out);
}

/**
 * Returns a Buffer suitable for THREE.GLTFLoader.parse (may be a decoded copy).
 * @param {Buffer} glbBuffer
 * @returns {Promise<Buffer>}
 */
export async function bufferForThreeGlbLoader(glbBuffer) {
  if (!glbJsonUsesRequiredTextureWebp(glbBuffer)) return glbBuffer;
  return decodeTextureWebpToPngGlb(glbBuffer);
}
