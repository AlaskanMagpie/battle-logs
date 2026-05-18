import type { CastFxKind, CombatHitMark } from "../game/state";
import type { SpellFxElement, SpellFxShape, UnitSizeClass } from "../game/types";

/** One frame of cast FX for audio (mirrors fields the renderer reads from `CastFxEvent`). */
export type MatchSfxCastEvent = {
  kind: CastFxKind;
  strikeVariant?: string;
  element?: SpellFxElement;
  secondaryElement?: SpellFxElement;
  shape?: SpellFxShape;
};

/**
 * Very light procedural match SFX (Web Audio). Kept intentionally quiet so
 * dense combat does not become fatiguing — no external samples required.
 */
export class MatchSfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;

  resumeFromGesture(): void {
    const c = this.ctx;
    if (c?.state === "suspended") void c.resume();
  }

  dispose(): void {
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
      this.master = null;
      this.noiseBuf = null;
    }
  }

  private ensure(): { ctx: AudioContext; master: GainNode } | null {
    if (typeof window === "undefined") return null;
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    if (!this.ctx) {
      this.ctx = new AC({ latencyHint: "interactive" });
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.16;
      this.master.connect(this.ctx.destination);
    }
    return this.ctx && this.master ? { ctx: this.ctx, master: this.master } : null;
  }

  private getNoiseBuffer(ctx: AudioContext): AudioBuffer {
    if (!this.noiseBuf || this.noiseBuf.sampleRate !== ctx.sampleRate) {
      const frames = Math.ceil(ctx.sampleRate * 0.12);
      const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < frames; i++) ch[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
    }
    return this.noiseBuf;
  }

  private thump(
    ctx: AudioContext,
    master: GainNode,
    t0: number,
    opts: { freq: number; noiseMix: number; duration: number; gain: number },
  ): void {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(opts.freq * 1.25, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(36, opts.freq * 0.55), t0 + opts.duration * 0.65);

    const toneGain = ctx.createGain();
    toneGain.gain.setValueAtTime(0.0001, t0);
    toneGain.gain.linearRampToValueAtTime(opts.gain, t0 + 0.006);
    toneGain.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.duration);

    const src = ctx.createBufferSource();
    src.buffer = this.getNoiseBuffer(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(opts.freq * 2.2, t0);
    bp.Q.value = 0.85;

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.0001, t0);
    noiseGain.gain.linearRampToValueAtTime(opts.gain * opts.noiseMix, t0 + 0.004);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.duration * 0.9);

    osc.connect(toneGain);
    toneGain.connect(master);
    src.connect(bp);
    bp.connect(noiseGain);
    noiseGain.connect(master);
    osc.start(t0);
    osc.stop(t0 + opts.duration + 0.02);
    src.start(t0);
    src.stop(t0 + opts.duration + 0.02);
  }

  private tickTone(ctx: AudioContext, master: GainNode, t0: number, freq: number, gain: number, dur: number): void {
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(freq, t0);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(master);
    o.start(t0);
    o.stop(t0 + dur + 0.015);
  }

  private swish(ctx: AudioContext, master: GainNode, t0: number, gain: number, startHz: number, endHz: number): void {
    const src = ctx.createBufferSource();
    src.buffer = this.getNoiseBuffer(ctx);
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.Q.value = 1.05;
    f.frequency.setValueAtTime(startHz, t0);
    f.frequency.exponentialRampToValueAtTime(Math.max(120, endHz), t0 + 0.07);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09);
    src.connect(f);
    f.connect(g);
    g.connect(master);
    src.start(t0);
    src.stop(t0 + 0.1);
  }

  /** Soft beating partials — default wizard “school” timbre. */
  private arcaneWizardCore(ctx: AudioContext, master: GainNode, t0: number, g: number): void {
    const o1 = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    o1.type = "sine";
    o2.type = "sine";
    o1.frequency.setValueAtTime(261.6, t0);
    o2.frequency.setValueAtTime(277.2, t0);
    const merge = ctx.createGain();
    merge.gain.value = 1;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(420, t0);
    bp.frequency.exponentialRampToValueAtTime(880, t0 + 0.07);
    bp.Q.value = 1.15;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(g * 0.36, t0 + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.095);
    o1.connect(merge);
    o2.connect(merge);
    merge.connect(bp);
    bp.connect(env);
    env.connect(master);
    o1.start(t0);
    o2.start(t0);
    o1.stop(t0 + 0.1);
    o2.stop(t0 + 0.1);
  }

  /** Distinct, understated wizard spell read per visual element (procedural). */
  private elementWizardSpell(ctx: AudioContext, master: GainNode, t0: number, el: SpellFxElement, gain: number): void {
    const g = Math.min(0.048, Math.max(0.014, gain));

    switch (el) {
      case "fire": {
        const src = ctx.createBufferSource();
        src.buffer = this.getNoiseBuffer(ctx);
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.Q.value = 0.7;
        lp.frequency.setValueAtTime(1100, t0);
        lp.frequency.exponentialRampToValueAtTime(340, t0 + 0.056);
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, t0);
        env.gain.linearRampToValueAtTime(g * 0.95, t0 + 0.005);
        env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.068);
        src.connect(lp);
        lp.connect(env);
        env.connect(master);
        const u = ctx.createOscillator();
        u.type = "sine";
        u.frequency.setValueAtTime(185, t0);
        u.frequency.exponentialRampToValueAtTime(96, t0 + 0.05);
        const ug = ctx.createGain();
        ug.gain.setValueAtTime(0.0001, t0);
        ug.gain.linearRampToValueAtTime(g * 0.22, t0 + 0.004);
        ug.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.055);
        u.connect(ug);
        ug.connect(master);
        src.start(t0);
        src.stop(t0 + 0.075);
        u.start(t0);
        u.stop(t0 + 0.07);
        break;
      }
      case "lightning": {
        const freqs = [5200, 6800, 4100];
        for (let i = 0; i < freqs.length; i++) {
          const ti = t0 + i * 0.004;
          const o = ctx.createOscillator();
          o.type = "sine";
          o.frequency.setValueAtTime(freqs[i]!, ti);
          o.frequency.exponentialRampToValueAtTime(freqs[i]! * 0.55, ti + 0.018);
          const gg = ctx.createGain();
          gg.gain.setValueAtTime(0.0001, ti);
          gg.gain.linearRampToValueAtTime(g * (0.34 - i * 0.06), ti + 0.0015);
          gg.gain.exponentialRampToValueAtTime(0.0001, ti + 0.028);
          o.connect(gg);
          gg.connect(master);
          o.start(ti);
          o.stop(ti + 0.035);
        }
        break;
      }
      case "earth": {
        this.thump(ctx, master, t0, { freq: 78, noiseMix: 0.48, duration: 0.1, gain: g * 0.92 });
        const src = ctx.createBufferSource();
        src.buffer = this.getNoiseBuffer(ctx);
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.setValueAtTime(260, t0);
        bp.frequency.exponentialRampToValueAtTime(160, t0 + 0.06);
        bp.Q.value = 0.9;
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, t0);
        env.gain.linearRampToValueAtTime(g * 0.35, t0 + 0.003);
        env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.07);
        src.connect(bp);
        bp.connect(env);
        env.connect(master);
        src.start(t0);
        src.stop(t0 + 0.08);
        break;
      }
      case "water": {
        const src = ctx.createBufferSource();
        src.buffer = this.getNoiseBuffer(ctx);
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.Q.value = 0.55;
        lp.frequency.setValueAtTime(2200, t0);
        lp.frequency.exponentialRampToValueAtTime(380, t0 + 0.078);
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, t0);
        env.gain.linearRampToValueAtTime(g * 0.72, t0 + 0.012);
        env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.088);
        src.connect(lp);
        lp.connect(env);
        env.connect(master);
        src.start(t0);
        src.stop(t0 + 0.095);
        this.tickTone(ctx, master, t0 + 0.045, 990, g * 0.12, 0.04);
        break;
      }
      case "air": {
        const src = ctx.createBufferSource();
        src.buffer = this.getNoiseBuffer(ctx);
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.Q.value = 0.65;
        bp.frequency.setValueAtTime(3200, t0);
        bp.frequency.exponentialRampToValueAtTime(6200, t0 + 0.048);
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, t0);
        env.gain.linearRampToValueAtTime(g * 0.42, t0 + 0.02);
        env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.072);
        src.connect(bp);
        bp.connect(env);
        env.connect(master);
        src.start(t0);
        src.stop(t0 + 0.08);
        break;
      }
      case "lava": {
        const src = ctx.createBufferSource();
        src.buffer = this.getNoiseBuffer(ctx);
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.Q.value = 0.85;
        lp.frequency.setValueAtTime(720, t0);
        lp.frequency.exponentialRampToValueAtTime(180, t0 + 0.085);
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, t0);
        env.gain.linearRampToValueAtTime(g * 0.88, t0 + 0.008);
        env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.095);
        src.connect(lp);
        lp.connect(env);
        env.connect(master);
        const u = ctx.createOscillator();
        u.type = "sine";
        u.frequency.setValueAtTime(108, t0);
        u.frequency.exponentialRampToValueAtTime(58, t0 + 0.09);
        const ug = ctx.createGain();
        ug.gain.setValueAtTime(0.0001, t0);
        ug.gain.linearRampToValueAtTime(g * 0.28, t0 + 0.006);
        ug.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09);
        u.connect(ug);
        ug.connect(master);
        src.start(t0);
        src.stop(t0 + 0.1);
        u.start(t0);
        u.stop(t0 + 0.1);
        break;
      }
      case "snow": {
        const src = ctx.createBufferSource();
        src.buffer = this.getNoiseBuffer(ctx);
        const hp = ctx.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.setValueAtTime(4800, t0);
        hp.Q.value = 0.45;
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, t0);
        env.gain.linearRampToValueAtTime(g * 0.38, t0 + 0.004);
        env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.055);
        src.connect(hp);
        hp.connect(env);
        env.connect(master);
        this.tickTone(ctx, master, t0 + 0.002, 2640, g * 0.14, 0.038);
        src.start(t0);
        src.stop(t0 + 0.065);
        break;
      }
      case "arcane": {
        this.arcaneWizardCore(ctx, master, t0, g);
        break;
      }
      case "reclaim": {
        const src = ctx.createBufferSource();
        src.buffer = this.getNoiseBuffer(ctx);
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.setValueAtTime(920, t0);
        bp.frequency.exponentialRampToValueAtTime(420, t0 + 0.08);
        bp.Q.value = 1.2;
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, t0);
        env.gain.linearRampToValueAtTime(g * 0.55, t0 + 0.018);
        env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.095);
        src.connect(bp);
        bp.connect(env);
        env.connect(master);
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.setValueAtTime(148, t0);
        o.frequency.exponentialRampToValueAtTime(112, t0 + 0.085);
        const og = ctx.createGain();
        og.gain.setValueAtTime(0.0001, t0);
        og.gain.linearRampToValueAtTime(g * 0.22, t0 + 0.028);
        og.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.1);
        o.connect(og);
        og.connect(master);
        src.start(t0);
        src.stop(t0 + 0.1);
        o.start(t0);
        o.stop(t0 + 0.11);
        break;
      }
      case "shield": {
        const o = ctx.createOscillator();
        o.type = "triangle";
        o.frequency.setValueAtTime(660, t0);
        o.frequency.exponentialRampToValueAtTime(440, t0 + 0.05);
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, t0);
        env.gain.linearRampToValueAtTime(g * 0.32, t0 + 0.002);
        env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.055);
        o.connect(env);
        env.connect(master);
        this.tickTone(ctx, master, t0 + 0.006, 1320, g * 0.12, 0.032);
        o.start(t0);
        o.stop(t0 + 0.065);
        break;
      }
      default: {
        this.arcaneWizardCore(ctx, master, t0, g);
        break;
      }
    }
  }

  private sizeClassThumpFreq(size: UnitSizeClass): number {
    switch (size) {
      case "Swarm":
        return 190;
      case "Line":
        return 155;
      case "Heavy":
        return 118;
      case "Titan":
        return 88;
      default:
        return 140;
    }
  }

  /** One blended hit per frame from combat wedge marks. */
  playCombatHits(marks: readonly CombatHitMark[]): void {
    const pair = this.ensure();
    if (!pair || marks.length === 0) return;
    const { ctx, master } = pair;
    const t0 = ctx.currentTime;
    const n = Math.min(6, marks.length);
    const ref = marks[0]!;
    const seed = ref.visualSeed & 0xffff;
    const detune = 1 + ((seed % 13) - 6) * 0.007;
    let f = this.sizeClassThumpFreq(ref.sizeClass) * detune;
    if (ref.signal === "Bastion") f *= 0.94;
    if (ref.signal === "Vanguard") f *= 1.05;
    if (ref.signal === "Reclaim") f *= 1.02;
    const wide = marks.some((m) => m.wide);
    const ally = ref.team === "player";
    let duration = 0.072 + n * 0.004;
    let noiseMix = wide ? 0.55 : 0.36 + (seed & 1) * 0.06;
    if (ref.rangeBand === "long") {
      duration += 0.018;
      f *= 0.93;
      noiseMix += 0.05;
    } else if (ref.rangeBand === "medium") {
      noiseMix += 0.03;
    }
    const gain = 0.045 + 0.012 * Math.sqrt(n) + (wide ? 0.012 : 0);
    this.thump(ctx, master, t0, {
      freq: f * (ally ? 1.04 : 0.96),
      noiseMix,
      duration,
      gain: Math.min(0.11, gain),
    });
    if (ref.trait === "lifesteal") {
      this.tickTone(ctx, master, t0 + 0.038, 1180 + (seed % 5) * 18, 0.011, 0.028);
    }
  }

  playSiegeTell(): void {
    const pair = this.ensure();
    if (!pair) return;
    const { ctx, master } = pair;
    const t0 = ctx.currentTime;
    this.thump(ctx, master, t0, { freq: 72, noiseMix: 0.72, duration: 0.14, gain: 0.065 });
    this.tickTone(ctx, master, t0 + 0.02, 95, 0.028, 0.1);
  }

  private collectSpellElements(events: readonly MatchSfxCastEvent[]): SpellFxElement[] {
    const out: SpellFxElement[] = [];
    const push = (el: SpellFxElement | undefined): void => {
      if (!el) return;
      if (!out.includes(el)) out.push(el);
    };
    for (const e of events) {
      if (e.kind === "elemental_spell") {
        push(e.element ?? "arcane");
        if (e.secondaryElement && e.secondaryElement !== e.element) push(e.secondaryElement);
      } else if (e.kind === "firestorm") push("fire");
      else if (e.kind === "lightning") push("lightning");
      else if (e.kind === "reclaim_pulse") push("reclaim");
    }
    return out;
  }

  /**
   * Summarizes a frame's cast FX queue into a few soft accents so many simultaneous
   * procs do not stack into harsh clipping.
   */
  playCastFxBatch(events: readonly MatchSfxCastEvent[]): void {
    const pair = this.ensure();
    if (!pair || events.length === 0) return;
    const { ctx, master } = pair;
    let t = ctx.currentTime + 0.001;

    let hero = false;
    let heroPlayer = false;
    let boom = false;
    let slice = false;
    let support = false;
    let sparkle = false;
    let death = false;

    for (const e of events) {
      const k = e.kind;
      if (k === "hero_strike") {
        hero = true;
        heroPlayer = e.strikeVariant?.startsWith("player_") ?? false;
      } else if (k === "combat_boom" || k === "shatter" || k === "ground_crack") boom = true;
      else if (k === "line_cleave") slice = true;
      else if (k === "fortify" || k === "muster" || k === "claim") support = true;
      else if (k === "spark_burst") sparkle = true;
      else if (k === "death_flash") death = true;
    }

    const spellElements = this.collectSpellElements(events);
    const maxSpellLayers = 4;
    const spellToPlay = spellElements.slice(0, maxSpellLayers);
    const sliceCoveredBySpell =
      slice &&
      events.some((e) => e.kind === "elemental_spell" && (e.shape === "line" || e.shape === "beam"));

    const step = 0.022;
    const schedule = (fn: (at: number) => void): void => {
      fn(t);
      t += step;
    };

    if (hero) {
      schedule((at) =>
        this.swish(ctx, master, at, heroPlayer ? 0.055 : 0.048, heroPlayer ? 1580 : 1280, heroPlayer ? 340 : 300),
      );
    }
    if (boom) {
      schedule((at) => this.thump(ctx, master, at, { freq: 62, noiseMix: 0.62, duration: 0.11, gain: 0.058 }));
    }
    if (slice && !boom && !sliceCoveredBySpell) {
      schedule((at) => this.swish(ctx, master, at, 0.036, 2050, 360));
    }
    for (let i = 0; i < spellToPlay.length; i++) {
      const el = spellToPlay[i]!;
      const gain = 0.034 * 0.9 ** i;
      schedule((at) => this.elementWizardSpell(ctx, master, at, el, gain));
    }
    if (support) {
      schedule((at) => {
        const base = hero || boom ? 520 : 620;
        this.tickTone(ctx, master, at, base, 0.026, 0.07);
        this.tickTone(ctx, master, at + 0.035, base * 1.25, 0.018, 0.055);
      });
    }
    if (sparkle && !spellElements.includes("lightning")) {
      schedule((at) => this.tickTone(ctx, master, at, 1760, 0.018, 0.04));
    }
    if (death) {
      schedule((at) => {
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.setValueAtTime(220, at);
        o.frequency.exponentialRampToValueAtTime(55, at + 0.16);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, at);
        g.gain.linearRampToValueAtTime(0.03, at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
        o.connect(g);
        g.connect(master);
        o.start(at);
        o.stop(at + 0.22);
      });
    }
  }
}
