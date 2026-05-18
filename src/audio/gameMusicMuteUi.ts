import { getMatchMusicElement, resumeMatchMusicIfNeeded } from "./matchMusic";
import { getMenuMusicElement, resumeMenuMusicIfNeeded } from "./menuMusic";
import { readGameMusicMuted, writeGameMusicMuted } from "./musicPreference";
import { registerGameMusicMuteButton, syncGameMusicMuteButtonVisibility } from "./musicChrome";

let muteButton: HTMLButtonElement | null = null;

function syncMuteButtonLabel(): void {
  if (!muteButton) return;
  const muted = readGameMusicMuted();
  muteButton.setAttribute("aria-pressed", muted ? "true" : "false");
  muteButton.textContent = muted ? "Music off" : "Music on";
  muteButton.title = muted ? "Unmute game music" : "Mute game music";
}

export function applyGameMusicMutedToStreamElements(muted: boolean): void {
  const menu = getMenuMusicElement();
  const match = getMatchMusicElement();
  if (menu) menu.muted = muted;
  if (match) match.muted = muted;
}

export function toggleGameMusicMuted(): void {
  const next = !readGameMusicMuted();
  writeGameMusicMuted(next);
  applyGameMusicMutedToStreamElements(next);
  syncMuteButtonLabel();
  if (!next) {
    resumeMenuMusicIfNeeded();
    resumeMatchMusicIfNeeded();
  }
}

export function syncGameMusicMuteButtonFromPref(): void {
  applyGameMusicMutedToStreamElements(readGameMusicMuted());
  syncMuteButtonLabel();
}

/** Fixed corner control for menu + match BGM. */
export function installGameMusicMuteControl(): void {
  if (muteButton) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "menu-music-mute";
  btn.style.display = "none";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleGameMusicMuted();
  });
  document.body.appendChild(btn);
  muteButton = btn;
  registerGameMusicMuteButton(btn);
  syncMuteButtonLabel();
  syncGameMusicMuteButtonVisibility();
}
