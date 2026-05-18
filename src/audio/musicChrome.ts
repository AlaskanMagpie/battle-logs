/** Mute-button visibility (no dependency on menu/match modules — avoids import cycles). */

let muteButton: HTMLButtonElement | null = null;
let pickerActive = false;
let matchActive = false;

export function registerGameMusicMuteButton(btn: HTMLButtonElement): void {
  muteButton = btn;
  syncGameMusicMuteButtonVisibility();
}

export function setGameMusicChromePicker(on: boolean): void {
  pickerActive = on;
  syncGameMusicMuteButtonVisibility();
}

export function setGameMusicChromeMatch(on: boolean): void {
  matchActive = on;
  syncGameMusicMuteButtonVisibility();
}

export function syncGameMusicMuteButtonVisibility(): void {
  if (!muteButton) return;
  muteButton.style.display = pickerActive || matchActive ? "" : "none";
}
