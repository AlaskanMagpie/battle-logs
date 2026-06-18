/**
 * Headless frame-time probe for the mobile battlefield.
 *
 * Boots Vite, loads a mobile AI quick-match, lets the real requestAnimationFrame
 * loop run while the sim is driven forward, then reads the in-app frame profiler
 * (`window.__perf`, installed by src/dev/frameProfiler.ts).
 *
 * NOTE ON SIGNAL: headless Chromium uses software WebGL (SwiftShader) and does
 * not emulate a 120Hz display, so the *inter-frame* numbers are not a faithful
 * stand-in for real-device fps. The trustworthy, device-independent signal here
 * is `cpuMs` — the per-frame JavaScript cost (sim + sync + render submit). For a
 * sustained 120fps that must sit comfortably under the 8.33ms budget with a
 * tight p99 tail. Run on a real phone via `window.__perf.summary()` for the true
 * display-cadence numbers.
 *
 * Usage: node scripts/perf-probe.mjs [--port 2231] [--seconds 6] [--url <base>]
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const root = process.cwd();

/**
 * Some CI/sandbox images pre-bake a Chromium build whose revision differs from
 * the one this Playwright version pins, so the default managed download path is
 * missing. Fall back to a pre-installed binary when present.
 */
function resolveChromiumExecutable() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    // `<base>/chromium` is commonly a symlink straight to the chrome binary.
    base ? path.join(base, "chromium") : null,
    base ? path.join(base, "chromium-1194", "chrome-linux", "chrome") : null,
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

function argValue(name, fallback) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const port = Number(argValue("--port", "2231"));
const baseUrl = argValue("--url", `http://localhost:${port}`);
const seconds = Number(argValue("--seconds", "6"));
const external = process.argv.includes("--external");
const profileCpu = process.argv.includes("--profile");
const settleSeconds = Number(argValue("--settle", "0.75"));
const warmupMs = Number(argValue("--warmup", "8000"));

/**
 * Aggregate a V8 CPU profile into self-time-per-function and print the top
 * offenders. `samples` indexes into `nodes`; `timeDeltas[i]` (microseconds) is
 * the time attributed to the node hit by `samples[i]`.
 */
function printCpuProfile(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const selfUsById = new Map();
  for (let i = 0; i < profile.samples.length; i += 1) {
    const id = profile.samples[i];
    const dt = profile.timeDeltas[i] ?? 0;
    selfUsById.set(id, (selfUsById.get(id) ?? 0) + Math.max(0, dt));
  }
  const byFn = new Map();
  for (const [id, us] of selfUsById) {
    const n = byId.get(id);
    if (!n) continue;
    const f = n.callFrame;
    const name = `${f.functionName || "(anonymous)"} ${String(f.url).split("/").pop()}:${f.lineNumber + 1}`;
    byFn.set(name, (byFn.get(name) ?? 0) + us);
  }
  const top = [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18);
  console.log("=== top self-time functions (ms) ===");
  for (const [name, us] of top) console.log(`${(us / 1000).toFixed(1).padStart(8)}  ${name}`);
}

async function waitForServer(url, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Vite still booting.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

let server = null;
try {
  if (!external) {
    server = spawn(
      process.execPath,
      [
        path.join(root, "node_modules", "vite", "bin", "vite.js"),
        "--host",
        "localhost",
        "--port",
        String(port),
        "--strictPort",
        "--clearScreen",
        "false",
      ],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    server.stdout.on("data", () => {});
    server.stderr.on("data", (d) => process.stderr.write(d));
  }

  await waitForServer(baseUrl);
  const browser = await chromium.launch({
    headless: true,
    executablePath: resolveChromiumExecutable(),
    args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 412, height: 915 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    const url = `${baseUrl}/?quickMatch=1&opponent=ai&controlProfile=mobile&noOnboarding=1`;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof window.render_game_to_text === "function", null, {
      timeout: 25_000,
    });
    await page.waitForFunction(() => typeof window.__perf === "object" && window.__perf !== null, null, {
      timeout: 10_000,
    });

    // Spin the sim up so units, structures and FX are live. The real rAF tick()
    // advances the sim from wall-clock on its own, so once populated we let it
    // free-run and sample without further synchronous advanceTime calls (those
    // would starve rAF and pollute the inter-frame timing).
    await page.evaluate((ms) => window.advanceTime?.(ms), warmupMs);
    // Let the adaptive quality governor converge before sampling steady state.
    await page.waitForTimeout(Math.max(750, settleSeconds * 1000));
    await page.evaluate(() => window.__perf.reset());

    // Optional CPU profile to pinpoint spike sources (self time per function).
    let cdp = null;
    if (profileCpu) {
      cdp = await page.context().newCDPSession(page);
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 80 });
      await cdp.send("Profiler.start");
    }

    await page.waitForTimeout(Math.max(1000, seconds * 1000));

    if (cdp) {
      const { profile } = await cdp.send("Profiler.stop");
      printCpuProfile(profile);
    }

    const summary = await page.evaluate(() => window.__perf.summary());
    const fatal = pageErrors.filter((m) => !/WebGL|SwiftShader|shader|GL_|GROUP_MARKER/i.test(m));

    console.log("=== mobile frame profile ===");
    console.log(
      JSON.stringify(
        {
          frames: summary.frames,
          budgetMs: Number(summary.budgetMs.toFixed(3)),
          cpu: {
            avgMs: Number(summary.avgCpuMs.toFixed(3)),
            p95Ms: Number(summary.p95CpuMs.toFixed(3)),
            p99Ms: Number(summary.p99CpuMs.toFixed(3)),
            maxMs: Number(summary.maxCpuMs.toFixed(3)),
            withinBudget: summary.cpuWithinBudget,
          },
          interval_softwareGl_notRepresentative: {
            fps: Number(summary.fps.toFixed(1)),
            p99Ms: Number(summary.p99FrameMs.toFixed(3)),
            maxMs: Number(summary.maxFrameMs.toFixed(3)),
            longFrames: summary.longFrames,
          },
          renderInfo: summary.info ?? null,
        },
        null,
        2,
      ),
    );
    if (fatal.length) {
      console.error("non-WebGL page errors:\n" + fatal.join("\n"));
      process.exitCode = 1;
    }
    await page.close();
  } finally {
    await browser.close();
  }
} finally {
  if (server) server.kill();
}
