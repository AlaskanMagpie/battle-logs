/** Shared mute flag for menu BGM and match BGM (legacy key name). */
export const STORAGE_GAME_MUSIC_MUTED = "signalWarsMenuMusicMuted";

export function readGameMusicMuted(): boolean {
  try {
    return localStorage.getItem(STORAGE_GAME_MUSIC_MUTED) === "1";
  } catch {
    return false;
  }
}

export function writeGameMusicMuted(muted: boolean): void {
  try {
    localStorage.setItem(STORAGE_GAME_MUSIC_MUTED, muted ? "1" : "0");
  } catch {
    /* ignore */
  }
}
