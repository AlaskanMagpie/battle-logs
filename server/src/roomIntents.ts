import type { PlayerIntent } from "../../src/game/intents";
import type { MapData } from "../../src/game/types";

type Fields = Record<string,unknown>;
const object = (v:unknown):v is Fields => typeof v==="object" && v!==null && !Array.isArray(v);
const finite = (v:unknown):v is number => typeof v==="number" && Number.isFinite(v);
const integer = (v:unknown):v is number => finite(v) && Number.isSafeInteger(v);
const formations = ["line","wedge","arc"];
export function validRoomIntent(input:unknown,map:MapData):input is PlayerIntent {
  if(!object(input)) return false;
  const point=(p:unknown)=>object(p) && finite(p.x) && finite(p.z) &&
    Math.abs(p.x)<=map.world.halfExtents+1 && Math.abs(p.z)<=map.world.halfExtents+1 &&
    (p.surfaceId===undefined || map.surfaces?.some(s=>s.id===p.surfaceId)===true);
  switch(input.type){
    case "select_doctrine_slot":return integer(input.index) && input.index>=0 && input.index<10;
    case "try_click_world":return point(input.pos);
    case "select_units":return Array.isArray(input.unitIds) && input.unitIds.length<=512 && input.unitIds.every(integer);
    case "command_selected_units":return point(input) && ["move","attack_move","stay"].includes(String(input.mode));
    case "command_selected_units_formation":return point(input.from) && point(input.to) &&
      ["move","attack_move"].includes(String(input.mode)) &&
      (input.formationKind===undefined || formations.includes(String(input.formationKind))) &&
      (input.depthScale===undefined || finite(input.depthScale) && input.depthScale>0 && input.depthScale<=4);
    case "hero_move":case "hero_teleport":case "set_global_rally":return point(input);
    case "hero_wasd":return finite(input.strafe) && finite(input.forward) &&
      ["camFx","camFz","camRx","camRz"].every(k=>input[k]===undefined || finite(input[k]) && Math.abs(input[k])<=1);
    case "toggle_structure_orders":return integer(input.structureId);
    case "set_army_stance":return input.stance==="offense" || input.stance==="defense";
    case "set_formation_preset":return formations.includes(String(input.formationKind));
    case "set_hero_captain":return typeof input.enabled==="boolean";
    case "clear_placement":case "begin_rally_click":case "toggle_army_stance":case "toggle_hero_captain":
    case "toggle_formation_preset":case "begin_hero_teleport":case "hero_claim":case "hero_cancel_claim":case "start_battle":return true;
    default:return false;
  }
}
