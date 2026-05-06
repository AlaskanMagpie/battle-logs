/**
 * Fails the build if any .glb under public/ is a Git LFS pointer stub.
 * On CI hosts such as Vercel, try to hydrate unit GLBs first so builds can
 * recover when the initial checkout skipped LFS objects.
 */
import { execFileSync } from "child_process";
import { createReadStream } from "fs";
import { readdir } from "fs/promises";
import { join, relative } from "path";

async function collectGlbs(dir, acc = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await collectGlbs(p, acc);
    else if (e.name.endsWith(".glb")) acc.push(p);
  }
  return acc;
}

function readFirstChunk(path, max = 512) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const s = createReadStream(path, { start: 0, end: max - 1 });
    s.on("data", (d) => chunks.push(d));
    s.on("error", reject);
    s.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function findPointerGlbs(paths) {
  const bad = [];
  for (const abs of paths) {
    const buf = await readFirstChunk(abs, 400);
    const asText = buf.toString("utf8", 0, Math.min(buf.length, 200));
    if (asText.startsWith("version https://git-lfs.github.com/spec/") || asText.includes("git-lfs.github.com/spec")) {
      bad.push(relative(process.cwd(), abs));
    }
  }
  return bad;
}

function hydrateLfsGlbs() {
  console.error("[verify-public-glbs] Found Git LFS pointer files; attempting git lfs pull for unit GLBs...");
  execFileSync("git", ["lfs", "pull", "--include=public/assets/units/*.glb"], {
    cwd: process.cwd(),
    stdio: "inherit",
  });
}

const publicDir = join(process.cwd(), "public");
const glbs = await collectGlbs(publicDir);
let bad = await findPointerGlbs(glbs);

if (bad.length > 0) {
  try {
    hydrateLfsGlbs();
    bad = await findPointerGlbs(glbs);
  } catch (err) {
    console.error("\n[verify-public-glbs] Automatic git lfs pull failed.");
    if (err && typeof err === "object" && "message" in err) console.error(String(err.message));
  }
}

if (bad.length > 0) {
  console.error("\n[BAD] These paths are Git LFS pointer files, not real GLB binaries:\n");
  for (const p of bad) console.error(`  ${p}`);
  console.error(`
Vercel: Project -> Settings -> Git -> enable "Git Large File Storage (LFS)", then redeploy.
https://vercel.com/docs/project-configuration/git-settings

Local unit GLBs use LFS (.gitattributes: public/assets/units/*.glb). The build needs LFS checkout.
`);
  process.exit(1);
}

console.log(`[verify-public-glbs] OK - ${glbs.length} GLB(s) under public/`);
