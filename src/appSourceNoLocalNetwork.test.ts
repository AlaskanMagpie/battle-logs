import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const srcRoot = dirname(fileURLToPath(import.meta.url));
const sourceExt = /\.(ts|tsx|js|jsx|mjs|html)$/;
const forbidden = /\b(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[0-1])\.\d+\.\d+)/;

function appSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      out.push(...appSourceFiles(path));
      continue;
    }
    if (!sourceExt.test(name)) continue;
    if (/\.(test|spec)\./.test(name)) continue;
    out.push(path);
  }
  return out;
}

describe("production source network safety", () => {
  it("does not contain localhost or private-network URLs", () => {
    const offenders = appSourceFiles(srcRoot).filter((path) => forbidden.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });
});
