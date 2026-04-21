/** Ring buffer of recent game events for HUD + debugging (not persisted in save/replay). */

const MAX_LINES = 100;

export type GameLogCategory =
  | "move"
  | "claim"
  | "attack"
  | "damage"
  | "camera"
  | "input"
  | "combat";

export interface GameLogLine {
  tick: number;
  category: GameLogCategory;
  message: string;
}

const lines: GameLogLine[] = [];

export function logGame(category: GameLogCategory, message: string, tick: number): void {
  lines.push({ tick, category, message });
  if (lines.length > MAX_LINES) lines.shift();
  if (import.meta.env?.DEV) {
    // eslint-disable-next-line no-console
    console.log(`[${category}@${tick}] ${message}`);
  }
}

export function getGameLogLines(): readonly GameLogLine[] {
  return lines;
}

export function clearGameLog(): void {
  lines.length = 0;
}
