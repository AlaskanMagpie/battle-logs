import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAP_REGISTRY } from "./loadMap";
import { prepareMatchMapForRuntime } from "./mapArenaLayout";
import { validateMapLayout } from "./mapArenaValidation";
import type { MapData } from "./types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "../../public");

function loadMapFile(url: string): MapData {
  const rel = url.startsWith("/") ? url.slice(1) : url;
  const raw = readFileSync(join(publicDir, rel), "utf8");
  return JSON.parse(raw) as MapData;
}

describe("map layout validation", () => {
  for (const entry of MAP_REGISTRY) {
    it(`${entry.id} (${entry.url}) has no validation errors`, () => {
      const map = prepareMatchMapForRuntime(loadMapFile(entry.url));
      const issues = validateMapLayout(map);
      const errors = issues.filter((i) => i.level === "error");
      expect(errors, JSON.stringify(errors)).toEqual([]);
    });
  }
});
