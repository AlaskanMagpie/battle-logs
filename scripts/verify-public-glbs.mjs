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

/**
 * Vercel clones can leave LFS smudge unset and/or omit lfs.url; `git lfs pull` then fails with
 * `batch request: missing protocol: ""`. Point LFS at GitHub's batch endpoint when we know the slug.
 */
function tryConfigureGitLfsEndpointForCi() {
  const owner = String(process.env.VERCEL_GIT_REPO_OWNER ?? "").trim();
  const slug = String(process.env.VERCEL_GIT_REPO_SLUG ?? "").trim();
  const provider = String(process.env.VERCEL_GIT_PROVIDER ?? "github").trim().toLowerCase();
  if (!owner || !slug) {
    console.error(
      "[verify-public-glbs] No VERCEL_GIT_REPO_OWNER / VERCEL_GIT_REPO_SLUG; skipping LFS URL hint (non-Vercel or older env).",
    );
    return;
  }
  if (provider !== "github") {
    console.error(`[verify-public-glbs] Git provider "${provider}" — set LFS remote manually if pull fails.`);
    return;
  }
  const lfsUrl = `https://github.com/${owner}/${slug}.git/info/lfs`;
  try {
    execFileSync("git", ["lfs", "install", "--local"], { cwd: process.cwd(), stdio: "inherit" });
  } catch {
    /* lfs may already be installed */
  }
  try {
    execFileSync("git", ["config", "--local", "lfs.url", lfsUrl], { cwd: process.cwd(), stdio: "inherit" });
    console.error(`[verify-public-glbs] Set lfs.url for CI: ${lfsUrl}`);
  } catch (e) {
    console.error("[verify-public-glbs] Could not set lfs.url:", e?.message ?? e);
  }
  try {
    execFileSync("git", ["config", "--local", "remote.origin.lfsurl", lfsUrl], { cwd: process.cwd(), stdio: "inherit" });
  } catch {
    /* detached or custom remotes — lfs.url alone is often enough */
  }
}

function hydrateLfsGlbs() {
  console.error("[verify-public-glbs] Found Git LFS pointer files; attempting git lfs pull for unit GLBs...");
  if (process.env.VERCEL === "1") {
    tryConfigureGitLfsEndpointForCi();
  }
  try {
    execFileSync("git", ["lfs", "pull", "--include=public/assets/units/*.glb"], {
      cwd: process.cwd(),
      stdio: "inherit",
    });
  } catch (first) {
    console.error("[verify-public-glbs] Narrow LFS pull failed; retrying full `git lfs pull` for this checkout...");
    execFileSync("git", ["lfs", "pull"], { cwd: process.cwd(), stdio: "inherit" });
  }
}

function shouldAllowPointerGlbsInBuild() {
  const raw = String(process.env.ALLOW_LFS_POINTER_GLB_BUILD ?? "").trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  // Vercel previews can run without LFS checkout; runtime falls back if GLBs fail.
  return process.env.VERCEL === "1" && process.env.VERCEL_ENV !== "production";
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
  if (shouldAllowPointerGlbsInBuild()) {
    console.warn("\n[verify-public-glbs] WARNING: continuing build with Git LFS pointer GLBs.\n");
    for (const p of bad) console.warn(`  ${p}`);
    console.warn(`
Set ALLOW_LFS_POINTER_GLB_BUILD=false to force strict failures.
For full art in Vercel, enable Git LFS in Project Settings -> Git.
`);
    process.exit(0);
  }
  console.error("\n[BAD] These paths are Git LFS pointer files, not real GLB binaries:\n");
  for (const p of bad) console.error(`  ${p}`);
  console.error(`
Vercel: Project -> Settings -> Git -> enable "Git Large File Storage (LFS)" (smudge on clone), then redeploy.
https://vercel.com/docs/project-configuration/git-settings

This build also tries \`git lfs pull\` with an explicit GitHub \`/info/lfs\` URL from VERCEL_GIT_REPO_*.
If pull still fails, confirm the repo is public or that the builder can reach GitHub LFS.

Local unit GLBs use LFS (.gitattributes: public/assets/units/*.glb). The build needs real binaries or a working LFS pull.
`);
  process.exit(1);
}

console.log(`[verify-public-glbs] OK - ${glbs.length} GLB(s) under public/`);
