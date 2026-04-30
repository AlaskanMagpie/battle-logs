import { describe, expect, it } from "vitest";
import { DOCTRINE_SLOT_COUNT } from "./constants";
import { normalizeDoctrineSlotsForMatch } from "./state";
import {
  doctrineSlotsForUrlQuickMatch,
  fillDoctrineSlotsWithDuplicatePicks,
  isUserDoctrineHandViableForQuickMatch,
  QUICK_MATCH_DOCTRINE_SLOTS,
} from "./quickMatchDoctrine";

describe("quickMatch doctrine resolution", () => {
  it("preset is only the six full-art structures plus command spells (no legacy towers)", () => {
    const allowedStructures = new Set([
      "outpost",
      "watchtower",
      "bastion_keep",
      "verdant_citadel",
      "emberroot_bastion",
      "aionroot_observatory",
    ]);
    const allowedCommands = new Set(["recycle", "fortify", "firestorm", "shatter"]);
    const nonNull = QUICK_MATCH_DOCTRINE_SLOTS.filter((id): id is string => id != null);
    expect(nonNull.length).toBe(10);
    for (const id of nonNull) {
      expect(allowedStructures.has(id) || allowedCommands.has(id)).toBe(true);
    }
  });

  it("uses preset when saved hand is too sparse", () => {
    const sparse: (string | null)[] = Array.from({ length: DOCTRINE_SLOT_COUNT }, () => null);
    sparse[0] = "outpost";
    expect(isUserDoctrineHandViableForQuickMatch(sparse)).toBe(false);
    const resolved = doctrineSlotsForUrlQuickMatch(sparse);
    expect(resolved.filter(Boolean)).toHaveLength(DOCTRINE_SLOT_COUNT);
    expect(resolved).toEqual(fillDoctrineSlotsWithDuplicatePicks(normalizeDoctrineSlotsForMatch([...QUICK_MATCH_DOCTRINE_SLOTS])));
  });

  it("keeps a full binder-codex hand instead of replacing with preset", () => {
    const hand: (string | null)[] = Array.from({ length: DOCTRINE_SLOT_COUNT }, () => null);
    hand[0] = "watchtower";
    hand[1] = "bastion_keep";
    hand[2] = "verdant_citadel";
    hand[3] = "firestorm";
    expect(isUserDoctrineHandViableForQuickMatch(hand)).toBe(true);
    const resolved = doctrineSlotsForUrlQuickMatch(hand);
    expect(resolved[0]).toBe("watchtower");
    expect(resolved[1]).toBe("bastion_keep");
    expect(resolved[2]).toBe("verdant_citadel");
    expect(resolved[3]).toBe("firestorm");
    expect(resolved.filter(Boolean)).toHaveLength(DOCTRINE_SLOT_COUNT);
    expect(resolved[4]).toBe("watchtower");
    expect(resolved[5]).toBe("bastion_keep");
    expect(resolved[9]).toBe("bastion_keep");
  });

  it("fillDoctrineSlotsWithDuplicatePicks cycles distinct picks in first-seen order", () => {
    const row = Array.from({ length: DOCTRINE_SLOT_COUNT }, () => null as string | null);
    row[0] = "recycle";
    row[3] = "outpost";
    const filled = fillDoctrineSlotsWithDuplicatePicks(row);
    expect(filled.filter(Boolean)).toHaveLength(DOCTRINE_SLOT_COUNT);
    expect(filled[0]).toBe("recycle");
    // Pool is [recycle, outpost] from row scan; nulls cycle pool[fillIdx++] starting at 0.
    expect(filled[1]).toBe("recycle");
    expect(filled[2]).toBe("outpost");
    expect(filled[3]).toBe("outpost");
    expect(filled[4]).toBe("recycle");
    expect(filled[5]).toBe("outpost");
  });
});
