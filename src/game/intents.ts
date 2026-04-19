import type { ArmyStance } from "./state";
import type { Vec2 } from "./types";

export type PlayerIntent =
  | { type: "select_doctrine_slot"; index: number }
  | { type: "clear_placement" }
  | { type: "try_click_world"; pos: Vec2; shiftKey?: boolean; altKey?: boolean }
  | { type: "toggle_structure_orders"; structureId: number }
  | { type: "set_army_stance"; stance: ArmyStance }
  | { type: "toggle_army_stance" }
  | { type: "hero_move"; x: number; z: number }
  /** Strafe / forward axis from keyboard (-1, 0, 1); consumed in heroSystem. */
  | { type: "hero_wasd"; strafe: number; forward: number }
  | { type: "hero_claim" }
  | { type: "hero_cancel_claim" }
  | { type: "start_battle" };
