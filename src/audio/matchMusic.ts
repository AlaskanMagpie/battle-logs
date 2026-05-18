import { getBlobUrlForMediaPath } from "./blobMediaUrl";
import { matchMusicUrlForMap } from "../game/loadMap";
import { readGameMusicMuted } from "./musicPreference";
import { setGameMusicChromeMatch } from "./musicChrome";

let audio: HTMLAudioElement | null = null;
let activeUrl: string | null = null;
let sessionActive = false;
let gestureCleanup: (() => void) | null = null;

export function getMatchMusicElement(): HTMLAudioElement | null {
  return audio;
}

async function ensureAudioForUrl(url: string): Promise<HTMLAudioElement> {
  if (!audio || activeUrl !== url) {
    if (audio) {
      audio.pause();
      audio.src = "";
    }
    const el = new Audio();
    el.loop = true;
    el.preload = "auto";
    el.volume = 0.34;
    el.muted = readGameMusicMuted();
    el.src = await getBlobUrlForMediaPath(url);
    audio = el;
    activeUrl = url;
  } else {
    audio.muted = readGameMusicMuted();
  }
  return audio;
}

function armPlayOnFirstGesture(): void {
  if (gestureCleanup) return;
  const resume = (): void => {
    gestureCleanup?.();
    gestureCleanup = null;
    if (!sessionActive || !audio) return;
    void audio.play().catch(() => {});
  };
  const opts = { capture: true, passive: true } as const;
  window.addEventListener("pointerdown", resume, opts);
  gestureCleanup = () => window.removeEventListener("pointerdown", resume, opts);
}

function tryPlay(): void {
  if (!sessionActive || !audio) return;
  void audio.play().catch(() => {
    armPlayOnFirstGesture();
  });
}

function clearMatchAudio(): void {
  gestureCleanup?.();
  gestureCleanup = null;
  if (audio) {
    audio.pause();
    audio.src = "";
    audio = null;
    activeUrl = null;
  }
}

/** After terrain is ready; `mapUrl` is the same site path used for `loadMapMerged`. */
export function beginMatchMusicSession(mapUrl: string): void {
  sessionActive = true;
  const url = matchMusicUrlForMap(mapUrl);
  if (!url) {
    clearMatchAudio();
    return;
  }
  void ensureAudioForUrl(url).then(() => tryPlay());
}

export function endMatchMusicSession(): void {
  sessionActive = false;
  setGameMusicChromeMatch(false);
  gestureCleanup?.();
  gestureCleanup = null;
  if (audio) {
    audio.pause();
    audio.currentTime = 0;
  }
}

/** Rematch on the same map: restart BGM from the top. */
export function restartMatchMusicSession(mapUrl: string): void {
  if (!sessionActive) return;
  const url = matchMusicUrlForMap(mapUrl);
  if (!url) {
    clearMatchAudio();
    return;
  }
  void ensureAudioForUrl(url).then(() => {
    if (audio) {
      audio.currentTime = 0;
      tryPlay();
    }
  });
}

export function resumeMatchMusicIfNeeded(): void {
  if (!sessionActive || !activeUrl || readGameMusicMuted()) return;
  void ensureAudioForUrl(activeUrl).then(() => tryPlay());
}
