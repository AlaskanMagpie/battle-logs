import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
/** Dev uses 2223 by default (`vite.config.ts`); still clear 2222 for stale processes. */
const ports = [2222, 2223, 2224];
const DEV_PORT = 2223;

function run(command, args, opts = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: opts.stdio ?? "pipe",
    shell: false,
  });
}

function powershell(script) {
  return run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]);
}

function listeningPidsWin32() {
  const portList = ports.join(",");
  const ps = `
    $ErrorActionPreference = "SilentlyContinue";
    Get-NetTCPConnection -LocalPort ${portList} -State Listen |
      Select-Object -ExpandProperty OwningProcess -Unique
  `;
  const out = powershell(ps).stdout ?? "";
  return out
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

function listeningPidsPosix() {
  const pids = new Set();
  for (const port of ports) {
    const out = run("sh", ["-lc", `lsof -ti tcp:${port} 2>/dev/null || true`]).stdout ?? "";
    for (const line of out.split(/\r?\n/)) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
    }
  }
  return [...pids];
}

function killPids(pids) {
  if (!pids.length) {
    console.log(`[localhost] No existing listeners on ${ports.join(", ")}.`);
    return;
  }
  console.log(`[localhost] Closing old dev listeners: ${pids.join(", ")}`);
  if (process.platform === "win32") {
    powershell(`Stop-Process -Id ${pids.join(",")} -Force -ErrorAction SilentlyContinue`);
  } else {
    run("sh", ["-lc", `kill -9 ${pids.join(" ")} 2>/dev/null || true`]);
  }
}

function clearViteCache() {
  const dirs = [join(root, "node_modules", ".vite"), join(root, "node_modules", ".vite-temp")];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    rmSync(dir, { recursive: true, force: true });
    console.log(`[localhost] Cleared ${dir}`);
  }
}

function viteBin() {
  const exe = process.platform === "win32" ? "vite.cmd" : "vite";
  return join(root, "node_modules", ".bin", exe);
}

killPids(process.platform === "win32" ? listeningPidsWin32() : listeningPidsPosix());
clearViteCache();

const sync = run(process.execPath, [join(root, "scripts", "sync-card-manifest.mjs")], { stdio: "inherit" });
if (sync.status != null && sync.status !== 0) {
  process.exit(sync.status);
}

const bin = viteBin();
if (!existsSync(bin)) {
  console.error("[localhost] Missing local Vite binary. Run npm install first.");
  process.exit(1);
}

const origin = `http://127.0.0.1:${DEV_PORT}/`;
console.log(`[localhost] Starting Vite on ${origin}`);
console.log("[localhost] Opening browser (--open). If a tab stays blank, paste the URL above (not “localhost” if Windows IPv6 bites).");
console.log("[localhost] Stale UI: hard refresh (Ctrl+F5).");

const child = spawn(bin, ["--host", "127.0.0.1", "--port", String(DEV_PORT), "--strictPort", "--open"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
