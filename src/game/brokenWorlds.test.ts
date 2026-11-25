import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chapters, expeditionMap, expeditionSave, finishChapter, startExpedition } from "./expedition";
import { createInitialState, armTapClaimAnchor, shatterTapAnchor, inPlayerTerritory, tacticsFieldSpeedMult, tacticsFieldIncomingDamageMult, wizardTier } from "./state";
import { advanceWorldObjectives, updateSurface } from "./surfaces";
import { applyPlayerIntents } from "./sim/systems/intents";
import { economy } from "./sim/systems/economy";
import { heroSystem } from "./sim/systems/hero";
import { claimFluxRewardForTap } from "./sim/systems/homeDistance";
import type { MapData } from "./types";

function map(chapter: number): MapData {
  return JSON.parse(readFileSync("public/maps/"+chapters[chapter]+".json","utf8"));
}

afterEach(() => vi.unstubAllGlobals());

describe("Broken Worlds expedition", () => {
  it("keeps Fortify on its own deck through entry, exit and expiry", () => {
    const state = createInitialState(map(0), []);
    const deck = state.map.surfaces![0].id;
    state.tacticsFieldZones.push({
      x: 0, z: 0, surfaceId: deck, radius: 10, untilTick: 5,
      allySpeedMult: 1.2, enemySpeedMult: 0.8, allyDamageMult: 1.2,
      enemyDamageMult: 0.9, allyIncomingDamageMult: 0.8, enemyIncomingDamageMult: 1.1,
    });
    expect(tacticsFieldSpeedMult(state, "player", 0, 0)).toBe(1);
    expect(tacticsFieldSpeedMult(state, "player", 10, 0, deck)).toBe(1.2);
    expect(tacticsFieldSpeedMult(state, "enemy", 10.1, 0, deck)).toBe(1);
    expect(tacticsFieldIncomingDamageMult(state, "enemy", 0, 0, deck)).toBe(1.1);
    state.tick = 5;
    expect(tacticsFieldSpeedMult(state, "player", 0, 0, deck)).toBe(1);
  });
  it("reports an anchor breaking once and clears the shattered marker on rearm", () => {
    const state = createInitialState(map(0), []);
    const tap = state.taps[0];
    Object.assign(tap, { active: true, ownerTeam: "player" });
    shatterTapAnchor(state, tap);
    shatterTapAnchor(state, tap);
    expect(tap.shattered).toBe(true);
    expect(state.fxQueue.filter(event => event.cue === "anchor_break")).toEqual([
      {kind:"battle_cue", cue:"anchor_break", x:tap.x, z:tap.z, tick:state.tick},
    ]);
    armTapClaimAnchor(tap);
    expect(tap.shattered).toBeUndefined();
    expect(tap.anchorHp).toBe(200);
  });
  it.each([true,false])("carries the evacuation decision (%s) through both reloads and resets after the ending", rescued => {
    const saved = new Map<string,string>();
    vi.stubGlobal("localStorage", {
      setItem:(key:string,value:string)=>saved.set(key,value), getItem:(key:string)=>saved.get(key) ?? null,
    });
    const first = startExpedition();
    finishChapter(first,rescued);
    finishChapter(first,!rescued);
    const second = startExpedition();
    expect(second).toEqual({chapter:1,oath:rescued});
    expect(expeditionMap(map(1),second).tapSlots.some(t=>t.id==="oasis_landing")).toBe(rescued);
    finishChapter(second,!rescued);
    const last = startExpedition();
    expect(last).toEqual({chapter:2,oath:rescued});
    expect(expeditionMap(map(2),last).playerRelaySlots[0].id==="oath_entrance").toBe(rescued);
    expect(finishChapter(last,false)).toContain(rescued?"Covenant":"Solitary");
    expect(expeditionSave().chapter).toBe(3);
    expect(startExpedition()).toEqual(first);
  });
  it("guides the starting Wizard under the deck to capture the ford", () => {
    const state=createInitialState(map(0),[]);
    const ford=state.taps.find(t=>t.defId==="ford")!;
    applyPlayerIntents(state,[{type:"hero_move",x:ford.x,z:ford.z}]);
    for(let i=0;i<500;i++) {
      state.tick++;
      heroSystem(state);
      advanceWorldObjectives(state);
    }
    expect(state.hero.surfaceId).toBeUndefined();
    expect(ford.ownerTeam).toBe("player");
    expect(state.evacuationSecured).toBe(true);
  });
  it("requires twelve uninterrupted seconds of ford ownership", () => {
    const state=createInitialState(map(0),[]);
    const ford=state.taps.find(t=>t.defId==="ford")!;
    ford.active=true;
    ford.ownerTeam="player";
    for(let i=0;i<239;i++) advanceWorldObjectives(state);
    expect(state.evacuationSecured).toBeFalsy();
    shatterTapAnchor(state,ford);
    advanceWorldObjectives(state);
    expect(state.evacuationTicks).toBe(0);
    ford.active=true;
    ford.ownerTeam="player";
    for(let i=0;i<240;i++) advanceWorldObjectives(state);
    expect(state.evacuationSecured).toBe(true);
  });
  it("keeps an occupant on the closed ring and excludes new arrivals", () => {
    const state=createInitialState(map(2),[]);
    Object.assign(state.hero,{x:0,z:-44});
    for(let i=0;i<40;i++) {state.tick++;advanceWorldObjectives(state);}
    expect(state.map.ringAligned).toBe(true);
    expect(state.taps.every(t=>!t.ownerTeam)).toBe(true);
    const deck=state.map.surfaces![0];
    const crossing={x:0,z:0,surfaceId:deck.id};
    state.tick=state.orreryOpenUntil!;
    advanceWorldObjectives(state);
    expect(state.map.ringAligned).toBe(false);
    updateSurface(state,crossing);
    expect(crossing.surfaceId).toBe(deck.id);
    const arrival={x:deck.length/2-1,z:0};
    updateSurface(state,arrival);
    expect(arrival).not.toHaveProperty("surfaceId");
    crossing.x=deck.length/2+1;
    updateSurface(state,crossing);
    expect(crossing.surfaceId).toBeUndefined();
  });
  it("pays the fractional remainder and keeps exhausted anchor coverage until destruction", () => {
    const state=createInitialState(map(0),[]);
    const tap=state.taps.find(t=>t.defId==="ford")!;
    const other=state.taps[0];
    for(const t of [other,tap]) {
      t.ownerTeam="player";
      t.active=true;
      armTapClaimAnchor(t);
      t.yieldRemaining=0;
    }
    tap.yieldRemaining=0.0125;
    const before=state.flux;
    economy(state);
    economy(state);
    expect(state.flux-before).toBeCloseTo(0.0125,9);
    expect(tap.yieldRemaining).toBe(0);
    expect(inPlayerTerritory(state,tap)).toBe(true);
    const tier=wizardTier(state);
    shatterTapAnchor(state,tap);
    expect(inPlayerTerritory(state,tap)).toBe(false);
    expect(wizardTier(state)).toBeLessThan(tier);
    Object.assign(state.hero,{x:tap.x,z:tap.z});
    state.heroCaptainEnabled=false;
    const wallet=state.flux;
    for(let i=0;i<100;i++) heroSystem(state);
    expect(state.flux-wallet).toBe(claimFluxRewardForTap(state,"player",tap));
    expect(tap.yieldRemaining).toBe(325);
    expect(tap.anchorHp).toBe(200);
    expect(wizardTier(state)).toBe(tier);
  });
});
