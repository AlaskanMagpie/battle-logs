/**
 * Looping doctrine-picker (prematch) music. Stops when a match starts.
 * Mute preference: `musicPreference` + `gameMusicMuteUi`.
 */

import { getBlobUrlForMediaPath } from "./blobMediaUrl";
import { setGameMusicChromePicker } from "./musicChrome";
import { readGameMusicMuted } from "./musicPreference";

const MENU_AUDIO_URL = "/assets/audio/menu_white_starlight_wizard.mp3";

let audio: HTMLAudioElement | null = null;
let pickerSessionActive = false;
let gestureCleanup: (() => void) | null = null;

export function getMenuMusicElement(): HTMLAudioElement | null {
  return audio;
}

function ensureAudioShell(): HTMLAudioElement {
  if (!audio) {
    const el = new Audio();
    el.loop = true;
    el.preload = "auto";
    el.volume = 0.38;
    el.muted = readGameMusicMuted();
    audio = el;
  } else {
    audio.muted = readGameMusicMuted();
  }
  return audio;
}

async function ensureAudioSrcLoaded(): Promise<HTMLAudioElement> {
  const el = ensureAudioShell();
  if (!el.src) {
    el.src = await getBlobUrlForMediaPath(MENU_AUDIO_URL);
  }
  return el;
}

function armPlayOnFirstGesture(): void {
  if (gestureCleanup) return;
  const resume = (): void => {
    gestureCleanup?.();
    gestureCleanup = null;
    if (!pickerSessionActive) return;
    void ensureAudioSrcLoaded().then((a) => a.play().catch(() => {}));
  };
  const opts = { capture: true, passive: true } as const;
  window.addEventListener("pointerdown", resume, opts);
  gestureCleanup = () => window.removeEventListener("pointerdown", resume, opts);
}

function tryPlayMenuMusic(): void {
  if (!pickerSessionActive) return;
  void ensureAudioSrcLoaded().then((a) => {
    void a.play().catch(() => {
      armPlayOnFirstGesture();
    });
  });
}

/** Call when the doctrine binder / portal picker is shown. */
export function beginMenuMusicSession(): void {
  pickerSessionActive = true;
  setGameMusicChromePicker(true);
  tryPlayMenuMusic();
}

/** Call when leaving the picker for a match (or hiding the menu). */
export function endMenuMusicSession(): void {
  pickerSessionActive = false;
  setGameMusicChromePicker(false);
  gestureCleanup?.();
  gestureCleanup = null;
  if (audio) {
    audio.pause();
    audio.currentTime = 0;
  }
}

export function resumeMenuMusicIfNeeded(): void {
  if (pickerSessionActive && !readGameMusicMuted()) tryPlayMenuMusic();
}
