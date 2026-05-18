import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://127.0.0.1:2223/?quickMatch=1&opponent=human&matchStrictTimeoutMs=30000";
const outDir = "output/playwright/multiplayer-confirm";
const errors = [];

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });

async function newClient(label) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`${label} console: ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`${label} pageerror: ${err.message}`));
  return page;
}

try {
  const clientA = await newClient("A");
  const clientB = await newClient("B");
  await Promise.all([
    clientA.goto(url, { waitUntil: "domcontentloaded" }),
    clientB.goto(url, { waitUntil: "domcontentloaded" }),
  ]);

  for (const page of [clientA, clientB]) {
    await page.waitForFunction(() => typeof window.render_game_to_text === "function", null, { timeout: 90_000 });
  }
  for (const page of [clientA, clientB]) {
    await page.waitForFunction(
      () => {
        try {
          return JSON.parse(window.render_game_to_text()).aiOpponent === null;
        } catch {
          return false;
        }
      },
      null,
      { timeout: 90_000 },
    );
  }

  await clientA.waitForTimeout(9_000);
  const statesBefore = await Promise.all(
    [clientA, clientB].map((page) => page.evaluate(() => JSON.parse(window.render_game_to_text()))),
  );
  await clientA.waitForTimeout(3_000);
  const states = await Promise.all(
    [clientA, clientB].map((page) => page.evaluate(() => JSON.parse(window.render_game_to_text()))),
  );

  await clientA.screenshot({ path: `${outDir}/client-a.png`, fullPage: true });
  await clientB.screenshot({ path: `${outDir}/client-b.png`, fullPage: true });

  console.log(JSON.stringify({ url, statesBefore, states, errors, screenshots: outDir }, null, 2));
  if (errors.length > 0) process.exitCode = 2;
  if (!states.every((state, index) => state.aiOpponent === null && state.tick > statesBefore[index].tick)) {
    process.exitCode = 3;
  }
} finally {
  await browser.close();
}
