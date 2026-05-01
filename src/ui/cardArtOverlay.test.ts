import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { cardArtOverlayHtml, containCardArtRect } from "./cardArtOverlay";
import overlayLayoutsJson from "./cardArtOverlayLayouts.json";

function memoryLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
    removeItem(key: string) {
      store.delete(key);
    },
    key(index: number) {
      return [...store.keys()][index] ?? null;
    },
  } as Storage;
}

describe("isCardOverlayFieldVisible vs asset-lab legacy storage", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("localStorage", memoryLocalStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ignores legacy global visibility for command cards so spells keep stat lines", async () => {
    localStorage.setItem("battleLogs.cardOverlay.fieldVisibility", JSON.stringify({ mana: false, cooldown: false }));
    const { isCardOverlayFieldVisible } = await import("./cardArtOverlay");
    expect(isCardOverlayFieldVisible("firestorm", "mana")).toBe(true);
    expect(isCardOverlayFieldVisible("firestorm", "cooldown")).toBe(true);
  });

  it("still honors legacy global visibility for structure cards", async () => {
    localStorage.setItem("battleLogs.cardOverlay.fieldVisibility", JSON.stringify({ mana: false }));
    const { isCardOverlayFieldVisible } = await import("./cardArtOverlay");
    expect(isCardOverlayFieldVisible("outpost", "mana")).toBe(false);
  });

  it("migrates v1 per-card storage to v2 and drops command rows", async () => {
    const ls = memoryLocalStorage();
    vi.stubGlobal("localStorage", ls);
    ls.setItem(
      "battleLogs.cardOverlay.fieldVisibilityByCard",
      JSON.stringify({
        outpost: { mana: false },
        firestorm: { mana: false },
      }),
    );
    const { isCardOverlayFieldVisible } = await import("./cardArtOverlay");
    expect(isCardOverlayFieldVisible("outpost", "mana")).toBe(false);
    expect(isCardOverlayFieldVisible("firestorm", "mana")).toBe(true);
    expect(ls.getItem("battleLogs.cardOverlay.fieldVisibilityByCard.v2")).toBeTruthy();
    expect(ls.getItem("battleLogs.cardOverlay.fieldVisibilityByCard")).toBeNull();
  });
});

describe("containCardArtRect", () => {
  it("letterboxes tall art inside a wide box", () => {
    const r = containCardArtRect(0, 0, 300, 150, 100, 150);
    expect(r).toEqual({ x: 100, y: 0, w: 100, h: 150 });
  });

  it("letterboxes wide art inside a tall box", () => {
    const r = containCardArtRect(10, 20, 100, 300, 100, 100);
    expect(r).toEqual({ x: 10, y: 120, w: 100, h: 100 });
  });

  it("falls back to the normalized doctrine card aspect for invalid intrinsic sizes", () => {
    const r = containCardArtRect(0, 0, 300, 300, 0, 0);
    expect(r).toEqual({ x: 50, y: 0, w: 200, h: 300 });
  });
});

describe("card art overlay layout", () => {
  it("keeps saved field geometry independent from dynamic balance values", () => {
    const cards = overlayLayoutsJson.cards ?? {};
    for (const [catalogId, layout] of Object.entries(cards)) {
      const html = cardArtOverlayHtml(catalogId);
      expect(html, catalogId).toContain(`data-card-art-overlay="${catalogId}"`);
      for (const [fieldId, fieldLayout] of Object.entries(layout.fields ?? {})) {
        const fieldMatch = html.match(
          new RegExp(
            `data-overlay-field="${fieldId}"[^>]*data-overlay-x="([^"]+)"[^>]*data-overlay-y="([^"]+)"[^>]*data-overlay-w="([^"]+)"[^>]*data-overlay-h="([^"]+)"`,
          ),
        );
        expect(fieldMatch, `${catalogId}.${fieldId}`).not.toBeNull();
        expect(Number(fieldMatch?.[1])).toBe(fieldLayout.x);
        expect(Number(fieldMatch?.[2])).toBe(fieldLayout.y);
        expect(Number(fieldMatch?.[3])).toBe(fieldLayout.width);
        if (fieldLayout.height !== undefined) expect(Number(fieldMatch?.[4])).toBe(fieldLayout.height);
      }
    }
  });
});
