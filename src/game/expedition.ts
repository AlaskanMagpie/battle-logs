import type { MapData } from "./types";

export const chapters = ["drowned_causeway","emberroot_caldera","fallen_orrery"] as const;
const saveKey = "doctrine.expedition.v1";
export interface Expedition { chapter: number; oath: boolean }
export function expeditionSave(): Expedition {
  try {
    const v = JSON.parse(localStorage.getItem(saveKey) ?? "null");
    if (v && Number.isInteger(v.chapter) && v.chapter >= 0 && v.chapter <= 3 && typeof v.oath === "boolean") return v;
  } catch { /* A missing save starts a fresh expedition. */ }
  return {chapter:0,oath:false};
}
export function startExpedition(): Expedition {
  const saved = expeditionSave();
  const run = saved.chapter === 3 ? {chapter:0,oath:false} : saved;
  localStorage.setItem(saveKey,JSON.stringify(run));
  return run;
}
export function finishChapter(run: Expedition, rescued: boolean): string {
  const current = expeditionSave();
  const next = {chapter:run.chapter+1,oath:run.chapter===0?rescued:run.oath};
  if(current.chapter === run.chapter && current.oath === run.oath) localStorage.setItem(saveKey,JSON.stringify(next));
  if (next.chapter === 1) return next.oath ? "The ford held. The spellrunners carry their oath to Caldera." : "The abbey fell swiftly. Your host marches on Caldera alone.";
  if (next.chapter === 2) return next.oath ? "The Oasis reveals the western observatory entrance." : "Your army takes the old processional road to the observatory.";
  return next.oath ? "The Covenant of Three Worlds • The spellrunners return home under a restored moon." : "The Solitary Crown • The rings turn again beneath your banner.";
}
export function expeditionMap(map: MapData, run: Expedition): MapData {
  if (!run.oath || run.chapter === 0) return map;
  if (run.chapter === 1) return {...map,tapSlots:[...map.tapSlots.filter(t=>t.id!=="emberroot_caldera_1"),{id:"oasis_landing",x:-55,z:36}]};
  return {...map,playerRelaySlots:[{id:"oath_entrance",x:-75,z:57},...map.playerRelaySlots.slice(1)],playerStart:{x:-73,z:54}};
}
export function chapterObjective(run: Expedition): string {
  if(run.chapter===0) return "Hold the central ford for 12 seconds to evacuate the spellrunners, or finish the battle for a swift victory.";
  if(run.chapter===1) return run.oath ? "The rescued spellrunners secured an Oasis landing. Build your Driftwood Oasis there." : "Take the monastery from the lower terrace or contest its high claim.";
  return "Stand inside the observatory south of the rings to align the crossing.";
}
