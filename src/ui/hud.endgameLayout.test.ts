import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));

function extractEndgameStatTops(css: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /\.hud-endgame-stat--([a-z0-9-]+)\s*\{[^}]*?\btop:\s*([^;]+);/gs;
  for (const m of css.matchAll(re)) {
    const key = m[1]!;
    const top = m[2]!.trim();
    out.set(key, top);
  }
  return out;
}

function extractEndgameActionsTop(css: string): string | null {
  const match = /\.hud-endgame-actions\s*\{[^}]*?\btop:\s*([^;]+);/s.exec(css);
  return match?.[1]?.trim() ?? null;
}

function extractEndgameStatsInset(css: string): string | null {
  const match = /\.hud-endgame-stats\s*\{[^}]*?\binset:\s*([^;]+);/s.exec(css);
  return match?.[1]?.trim() ?? null;
}

describe("HUD endgame stat layout", () => {
  it("gives every endgame stat row a distinct vertical position (no accidental overlap)", () => {
    const cssPath = join(__dirname, "hud.css");
    const css = readFileSync(cssPath, "utf8");
    const tops = extractEndgameStatTops(css);
    const actionsTop = extractEndgameActionsTop(css);
    const statsInset = extractEndgameStatsInset(css);

    const required = [
      "time",
      "score",
      "best",
      "structures-built",
      "structures-lost",
      "units-produced",
      "units-lost",
      "enemy-kills",
      "commands-cast",
      "salvage-recovered",
    ] as const;

    for (const key of required) {
      expect(tops.has(key), `missing .hud-endgame-stat--${key} { top: ... } in hud.css`).toBe(true);
    }
    expect(tops.has("damage"), "victory/defeat art has no standalone damage row").toBe(false);
    expect(tops.has("top-damage"), "victory/defeat art has no top-damage row").toBe(false);

    const pctValues = required.map((k) => {
      const raw = tops.get(k)!;
      expect(raw.endsWith("%"), `${k} top should be a percentage, got: ${raw}`).toBe(true);
      return Number.parseFloat(raw.slice(0, -1));
    });

    const uniq = new Set(pctValues);
    expect(uniq.size, `duplicate endgame stat tops: ${pctValues.join(", ")}`).toBe(pctValues.length);

    for (let i = 1; i < pctValues.length; i++) {
      expect(pctValues[i]! > pctValues[i - 1]!, "endgame stat tops should increase down the card").toBe(true);
    }

    expect(actionsTop, "missing .hud-endgame-actions { top: ... } in hud.css").not.toBeNull();
    expect(actionsTop!.endsWith("%"), `actions top should be a percentage, got: ${actionsTop}`).toBe(true);
    const actionsPct = Number.parseFloat(actionsTop!.slice(0, -1));
    const lastStatPct = pctValues[pctValues.length - 1]!;
    expect(actionsPct - lastStatPct, "last stat row should leave room before the action buttons").toBeGreaterThanOrEqual(2);
    expect(statsInset, "stat row percentages must be measured against the full endgame artwork").toBe("0");
  });
});
