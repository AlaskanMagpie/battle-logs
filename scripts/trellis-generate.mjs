/**
 * Generate a static 3D asset from a single image using the FREE official
 * Microsoft TRELLIS.2 HuggingFace Space — no API key, no paid service, no
 * local GPU. The result lands in incoming/<name>/model.glb, ready for
 * `npm run assets:import-meshy:optimize`.
 *
 * Usage:
 *   node scripts/trellis-generate.mjs <image.(png|jpg|webp)> <asset_name> [options]
 *   node scripts/trellis-generate.mjs --list-api            # inspect the Space's endpoints
 *
 * Options:
 *   --space <id>   HF Space id (default: microsoft/TRELLIS.2)
 *   --unit         allow a name without the _building suffix (static names that
 *                  don't end in _building enter the random tower-art pool — see
 *                  docs/trellis2-static-asset-pilot.md)
 *
 * Env:
 *   HF_TOKEN       optional HuggingFace token (raises free-tier queue priority)
 *
 * Free-tier notes: the public Space queues requests and may take a few minutes
 * under load. Zero-config fallback: open the Space in a browser, download the
 * GLB, and drop it into incoming/<name>/model.glb yourself.
 *
 * Space APIs change; if the call fails this script prints the live endpoint list
 * so the ENDPOINT_CANDIDATES below can be updated to match.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@gradio/client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const incomingDir = path.join(repoRoot, "incoming");

const DEFAULT_SPACE = "microsoft/TRELLIS.2";

// Endpoint names seen across TRELLIS-family Spaces, tried in order. Each entry:
// the endpoint to call with the image, and which step (if any) must run first.
const ENDPOINT_CANDIDATES = ["/image_to_3d", "/generate_3d", "/run", "/predict"];
const GLB_EXTRACT_CANDIDATES = ["/extract_glb", "/extract_gltf"];

function fail(msg) {
  console.error(`[trellis-generate] ${msg}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
let space = DEFAULT_SPACE;
let allowUnitName = false;
let listApi = false;
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--space") space = argv[++i] ?? fail("--space needs a value");
  else if (a === "--unit") allowUnitName = true;
  else if (a === "--list-api") listApi = true;
  else if (a.startsWith("--")) fail(`Unknown option ${a}`);
  else positional.push(a);
}

const [imagePath, rawName] = positional;
if (!listApi) {
  if (!imagePath || !rawName) {
    fail("usage: node scripts/trellis-generate.mjs <image> <asset_name> [--space id] [--unit] [--list-api]");
  }
  if (!fs.existsSync(imagePath)) fail(`Image not found: ${imagePath}`);
}

const name = (rawName ?? "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "_")
  .replace(/^_+|_+$/g, "");
if (!listApi) {
  if (!name) fail(`Asset name "${rawName}" sanitizes to nothing`);
  if (!allowUnitName && !name.endsWith("_building")) {
    fail(
      `Name "${name}" must end in _building (static GLBs without the suffix enter the ` +
        `random in-game tower-art pool). Pass --unit to override deliberately.`,
    );
  }
}

const token = process.env.HF_TOKEN;
const client = await Client.connect(space, token ? { hf_token: token } : undefined).catch((e) =>
  fail(`Could not connect to Space "${space}": ${e?.message ?? e}`),
);

async function printApi() {
  const api = await client.view_api();
  const eps = { ...(api?.named_endpoints ?? {}) };
  console.log(`Endpoints on ${space}:`);
  for (const [name, def] of Object.entries(eps)) {
    const ins = (def.parameters ?? []).map((p) => `${p.parameter_name ?? p.label}:${p.python_type?.type ?? p.type}`);
    const outs = (def.returns ?? []).map((r) => r.python_type?.type ?? r.type);
    console.log(`  ${name}(${ins.join(", ")}) -> ${outs.join(", ")}`);
  }
}

if (listApi) {
  await printApi();
  process.exit(0);
}

const imageBlob = new Blob([fs.readFileSync(imagePath)]);
const api = await client.view_api();
const named = api?.named_endpoints ?? {};

function firstAvailable(candidates) {
  return candidates.find((c) => c in named);
}

function findFileResult(result) {
  // Walk the result payload for the first file whose url/path ends in .glb,
  // falling back to any file-shaped object.
  const queue = Array.isArray(result?.data) ? [...result.data] : [result];
  let anyFile = null;
  while (queue.length) {
    const v = queue.shift();
    if (!v || typeof v !== "object") continue;
    if (typeof v.url === "string" || typeof v.path === "string") {
      const ref = v.url ?? v.path;
      if (/\.glb(\?|$)/i.test(ref)) return v;
      anyFile ??= v;
    }
    queue.push(...Object.values(v));
  }
  return anyFile;
}

const genEndpoint = firstAvailable(ENDPOINT_CANDIDATES);
if (!genEndpoint) {
  console.error(`[trellis-generate] None of ${ENDPOINT_CANDIDATES.join(", ")} exist on ${space}.`);
  console.error("Live API below — update ENDPOINT_CANDIDATES in this script to match:\n");
  await printApi();
  process.exit(1);
}

console.log(`[trellis-generate] ${space} ${genEndpoint} <- ${path.basename(imagePath)} (free tier; may queue)`);
let result;
try {
  result = await client.predict(genEndpoint, { image: imageBlob });
} catch {
  // Some Spaces take positional args rather than named ones.
  result = await client.predict(genEndpoint, [imageBlob]).catch(async (e) => {
    console.error(`[trellis-generate] ${genEndpoint} failed: ${e?.message ?? e}\nLive API:`);
    await printApi();
    process.exit(1);
  });
}

let file = findFileResult(result);
// TRELLIS-family Spaces often return a preview first and expose GLB extraction
// as a second endpoint.
if (file && !/\.glb(\?|$)/i.test(file.url ?? file.path ?? "")) {
  const extract = firstAvailable(GLB_EXTRACT_CANDIDATES);
  if (extract) {
    console.log(`[trellis-generate] extracting GLB via ${extract}`);
    const extracted = await client.predict(extract, []).catch(() => null);
    const f2 = extracted && findFileResult(extracted);
    if (f2) file = f2;
  }
}
if (!file) {
  console.error("[trellis-generate] No file in Space response. Raw result:");
  console.error(JSON.stringify(result?.data ?? result, null, 2).slice(0, 4000));
  process.exit(1);
}

const url = file.url ?? file.path;
const res = await fetch(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
if (!res.ok) fail(`Download failed (${res.status}) from ${url}`);
const glb = Buffer.from(await res.arrayBuffer());
if (glb.subarray(0, 4).toString("utf8") !== "glTF") fail(`Downloaded file is not a GLB (${url})`);

const destDir = path.join(incomingDir, name);
fs.mkdirSync(destDir, { recursive: true });
const dest = path.join(destDir, "model.glb");
fs.writeFileSync(dest, glb);
console.log(`[trellis-generate] wrote ${path.relative(repoRoot, dest)} (${(glb.length / 1e6).toFixed(2)} MB)`);
console.log("Next: npm run assets:import-meshy:optimize");
