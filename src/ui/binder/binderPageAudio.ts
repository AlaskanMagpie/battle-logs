/**
 * Lightweight procedural binder sounds (Web Audio API).
 * Gated by prefers-reduced-motion — no audio in that mode.
 */

export function prefersReducedBinderMotion(): boolean {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
}

function nowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

export class BinderPageAudio {
  private ctx: AudioContext | null = null;
  private noise: AudioBufferSourceNode | null = null;
  private lastThudMs = 0;

  resumeFromGesture(): void {
    if (prefersReducedBinderMotion()) return;
    try {
      if (!this.ctx) this.ctx = new AudioContext();
      if (this.ctx.state === "suspended") void this.ctx.resume();
    } catch {
      /* ignore */
    }
  }

  frictionStart(): void {
    if (prefersReducedBinderMotion()) return;
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    this.frictionStop();
    const dur = 0.35;
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.45;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = 620;
    f.Q.value = 0.65;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(f);
    f.connect(g);
    g.connect(ctx.destination);
    const t0 = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.07, t0 + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
    this.noise = src;
  }

  frictionStop(): void {
    try {
      this.noise?.stop();
    } catch {
      /* ignore */
    }
    this.noise = null;
  }

  thud(): void {
    if (prefersReducedBinderMotion()) return;
    const t = nowMs();
    if (t - this.lastThudMs < 120) return;
    this.lastThudMs = t;
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(118, t0);
    osc.frequency.exponentialRampToValueAtTime(52, t0 + 0.11);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.22, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.22);
  }

  rustle(): void {
    if (prefersReducedBinderMotion()) return;
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const t0 = ctx.currentTime;
    const dur = 0.14;
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.35;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = "highpass";
    f.frequency.value = 900;
    const g = ctx.createGain();
    g.gain.value = 0.09;
    src.connect(f);
    f.connect(g);
    g.connect(ctx.destination);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  metalTick(): void {
    if (prefersReducedBinderMotion()) return;
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(880, t0);
    osc.frequency.exponentialRampToValueAtTime(1320, t0 + 0.04);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.045, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.08);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.09);
  }

  dispose(): void {
    this.frictionStop();
    try {
      void this.ctx?.close();
    } catch {
      /* ignore */
    }
    this.ctx = null;
  }
}
