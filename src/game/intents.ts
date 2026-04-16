import type { Vec2 } from "./types";

export type PlayerIntent =
  | { type: "select_doctrine_slot"; index: number }
  | { type: "clear_placement" }
  | { type: "try_click_world"; pos: Vec2; shiftKey?: boolean; altKey?: boolean }
  | { type: "toggle_hold_at"; pos: Vec2 };
