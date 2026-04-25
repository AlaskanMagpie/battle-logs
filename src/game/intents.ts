import type { ArmyStance } from "./state";
import type { Vec2 } from "./types";

export type PlayerIntent =
  | { type: "select_doctrine_slot"; index: number }
  | { type: "clear_placement" }
  /** Arm/disarm: next LMB on the map sets a global rally point (offense units march there until stance changes). */
  | { type: "begin_rally_click" }
  | {
      type: "try_click_world";
      pos: Vec2;
      shiftKey?: boolean;
      altKey?: boolean;
      /** Nearest unit under cursor from client raycast; omitted on old replays. */
      pickedUnitId?: number | null;
    }
  | { type: "toggle_structure_orders"; structureId: number }
  | { type: "set_army_stance"; stance: ArmyStance }
  | { type: "toggle_army_stance" }
  | { type: "hero_move"; x: number; z: number; shiftKey?: boolean }
  /**
   * Strafe / forward from keyboard (-1, 0, 1) in **camera** space when `camFx`…`camRz` are set
   * (W/S along view on the ground, A/D strafe). Otherwise legacy axis: A/D = world ±X, W/S = world ∓Z.
   */
  | {
      type: "hero_wasd";
      strafe: number;
      forward: number;
      camFx?: number;
      camFz?: number;
      camRx?: number;
      camRz?: number;
    }
  | { type: "hero_claim" }
  | { type: "hero_cancel_claim" }
  | { type: "start_battle" };
