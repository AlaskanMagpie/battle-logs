import { mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { chromium } from "playwright";

const root = process.cwd();
const outDir = path.join(root, "output", "mobile-smoke");
mkdirSync(outDir, { recursive: true });

function argValue(name, fallback) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const port = Number(argValue("--port", "2230"));
const baseUrl = argValue("--url", `http://localhost:${port}`);
const external = process.argv.includes("--external");

async function waitForServer(url, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Vite is still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function runViewport(browser, name, viewport, pathAndQuery) {
  const page = await browser.newPage({
    viewport,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const errors = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });

  await page.goto(`${baseUrl}${pathAndQuery}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.render_game_to_text === "function", null, { timeout: 20_000 });
  await page.evaluate(() => window.advanceTime?.(1000));
  await page.waitForTimeout(750);

  const metrics = await page.evaluate(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom };
    };
    const vv = window.visualViewport;
    const viewport = { w: vv?.width ?? window.innerWidth, h: vv?.height ?? window.innerHeight };
    return {
      viewport,
      text: window.render_game_to_text?.() ?? null,
      hud: rect(".hud-chrome"),
      hand: rect("#doctrine-track"),
      dock: rect("#hud-dock"),
      command: rect(".hud-match-side-controls"),
      vibe: rect(".hud-vibejam-link"),
      profile: document.documentElement.dataset.controlProfile,
    };
  });

  await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: false });
  await page.close();

  const problems = [];
  if (metrics.profile !== "mobile") problems.push(`expected mobile profile, got ${metrics.profile}`);
  if (errors.length) problems.push(errors.join("\n"));
  if (!metrics.hud || !metrics.hand) problems.push("missing HUD or doctrine hand");
  if (metrics.hud && metrics.hud.h > metrics.viewport.h * (viewport.width < viewport.height ? 0.2 : 0.28)) {
    problems.push(`HUD too tall: ${Math.round(metrics.hud.h)}px of ${Math.round(metrics.viewport.h)}px`);
  }
  if (metrics.hand && metrics.hand.y < metrics.viewport.h * (viewport.width < viewport.height ? 0.72 : 0.68)) {
    problems.push(`hand too high: y=${Math.round(metrics.hand.y)} in ${Math.round(metrics.viewport.h)}px viewport`);
  }
  if (problems.length) {
    throw new Error(`${name} failed:\n${problems.join("\n")}`);
  }
  console.log(`${name}: ok`, JSON.stringify(metrics));
}

let server = null;
try {
  if (!external) {
    server = spawn(process.execPath, [
      path.join(root, "node_modules", "vite", "bin", "vite.js"),
      "--host",
      "localhost",
      "--port",
      String(port),
      "--strictPort",
      "--clearScreen",
      "false",
    ], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    server.stdout.on("data", (d) => process.stdout.write(d));
    server.stderr.on("data", (d) => process.stderr.write(d));
  }

  await waitForServer(baseUrl);
  const browser = await chromium.launch({ headless: true });
  try {
    const matchQuery = "/?quickMatch=1&opponent=ai&controlProfile=mobile&noOnboarding=1";
    await runViewport(browser, "portrait-match", { width: 412, height: 915 }, matchQuery);
    await runViewport(browser, "landscape-match", { width: 915, height: 412 }, matchQuery);
  } finally {
    await browser.close();
  }
} finally {
  if (server) server.kill();
}
