import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ports = [2222, 2223, 2224];

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

const bin = viteBin();
if (!existsSync(bin)) {
  console.error("[localhost] Missing local Vite binary. Run npm install first.");
  process.exit(1);
}

console.log("[localhost] Starting fresh Vite on http://localhost:2222/");
console.log("[localhost] If the browser still looks stale, hard refresh the tab (Ctrl+F5).");

const child = spawn(bin, ["--host", "localhost", "--port", "2222", "--strictPort"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
