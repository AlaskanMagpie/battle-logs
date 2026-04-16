import type { SignalType, Vec2 } from "./types";

export type PlayerIntent =
  | { type: "select_doctrine_slot"; index: number }
  | { type: "clear_placement" }
  | { type: "try_click_world"; pos: Vec2; shiftKey?: boolean }
  | { type: "confirm_relay_signal"; signal: SignalType }
  | { type: "cancel_relay_signal" }
  | { type: "toggle_structure_orders"; structureId: number };
