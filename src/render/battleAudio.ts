import type { CastFxEvent } from "../game/state";

// Frequency contours give each event its own rhythm on small phone speakers.
const tones = {
  claim: [392, 494, 659],
  anchor_break: [233, 147, 73],
  heavy_windup: [82, 104],
  tower_complete: [196, 294, 392],
  producer_restart: [330, 440],
  fire_warning: [554, 622],
  firestorm: [123, 55],
  shatter: [1047, 659, 392],
  fortify: [196, 247, 294],
  line_cleave: [740, 247],
};
type Cue = keyof typeof tones;
const preference = "doctrine-battle-muted";

export class BattleAudio {
  private context?: AudioContext;
  private listeners = new AbortController();
  private last = new Map<Cue, number>();
  private active = 0;
  private muted = false;

  constructor() {
    try { this.muted = localStorage.getItem(preference) === "1"; } catch {}
    const options = { signal: this.listeners.signal };
    const unlock = () => {
      if (this.muted || !window.AudioContext) return;
      this.context ??= new AudioContext();
      if (this.context.state === "suspended") void this.context.resume().catch(() => {});
    };
    window.addEventListener("pointerdown", unlock, options);
    window.addEventListener("keydown", unlock, options);
    document.addEventListener("click", (event) => {
      const toggle = (event.target as Element)?.closest?.("[data-battle-audio]");
      if (!toggle) return;
      this.muted = !this.muted;
      try { localStorage.setItem(preference, this.muted ? "1" : "0"); } catch {}
      if (!this.muted) unlock();
      toggle.textContent = this.muted ? "Battle sound off" : "Battle sound on";
      toggle.setAttribute("aria-pressed", String(!this.muted));
    }, options);
  }

  play(event: CastFxEvent) {
    const cue = event.kind === "battle_cue" ? event.cue : event.kind;
    const ctx = this.context;
    if (!cue || !(cue in tones) || !ctx || ctx.state !== "running" || this.muted || document.hidden) return;
    const key = cue as Cue;
    const now = ctx.currentTime;
    if (this.active >= 8 || now - (this.last.get(key) ?? -1) < 0.18) return;
    this.last.set(key, now);
    const notes = tones[key];
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = key === "anchor_break" || key === "firestorm" ? "sawtooth" : "triangle";
    notes.forEach((hz, index) => osc.frequency.setTargetAtTime(hz, now + index * 0.075, 0.012));
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.065, now + 0.015);
    const end = now + notes.length * 0.075 + 0.08;
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(gain).connect(ctx.destination);
    this.active++;
    osc.onended = () => { this.active--; osc.disconnect(); gain.disconnect(); };
    osc.start(now);
    osc.stop(end);
  }

  dispose() {
    this.listeners.abort();
    if (this.context) void this.context.close().catch(() => {});
  }
}
