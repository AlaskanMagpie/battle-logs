import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DOCTRINE_STORAGE_KEY, loadDoctrinePickerState } from "./doctrineStorage";
import { QUICK_MATCH_DOCTRINE_SLOTS } from "../game/quickMatchDoctrine";

function installLocalStorageMock(): void {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      store.set(key, value);
    },
    removeItem: (key: string): void => {
      store.delete(key);
    },
    clear: (): void => {
      store.clear();
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: localStorage,
  });
}

describe("doctrine storage first-run defaults", () => {
  beforeEach(() => {
    installLocalStorageMock();
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it("seeds a first-time browser with the full quickplay starter doctrine", () => {
    const loaded = loadDoctrinePickerState();

    expect(loaded.isFirstRun).toBe(true);
    expect(loaded.slots).toEqual([...QUICK_MATCH_DOCTRINE_SLOTS]);
    expect(loaded.slots.filter(Boolean)).toHaveLength(10);

    const saved = JSON.parse(localStorage.getItem(DOCTRINE_STORAGE_KEY) ?? "null") as { slots?: unknown };
    expect(saved?.slots).toEqual([...QUICK_MATCH_DOCTRINE_SLOTS]);
  });

  it("does not mark the persisted starter doctrine as first-run again", () => {
    loadDoctrinePickerState();

    const loadedAgain = loadDoctrinePickerState();

    expect(loadedAgain.isFirstRun).toBeUndefined();
    expect(loadedAgain.slots).toEqual([...QUICK_MATCH_DOCTRINE_SLOTS]);
  });
});
