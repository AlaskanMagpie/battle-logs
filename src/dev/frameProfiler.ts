/**
 * Near-zero-overhead frame profiler.
 *
 * The "perfect 120fps, no jitter, no random pauses" goal is only meaningful if
 * it is measurable, so this records two independent signals into preallocated
 * ring buffers (no per-frame heap allocation):
 *
 *  - `interval`: wall-clock gap between successive animation frames. This is
 *    what the player actually feels — the display cadence. A clean 120Hz stream
 *    sits at ~8.33ms with tight variance; jitter and stalls show up as a fat
 *    tail and large `maxFrameMs`.
 *  - `cpu`: time spent in our per-frame JavaScript work (sim catch-up + sync +
 *    render submission). This is device-GPU-independent, so it stays meaningful
 *    even in a software-WebGL headless probe where the displayed frame rate is
 *    not representative of real mobile hardware.
 *
 * `summary()` is the only allocating call and is meant to be polled out of band
 * (a perf probe, a debug key), never inside the frame loop.
 */

export interface FrameStats {
  /** Samples considered in this summary. */
  frames: number;
  /** Effective frame rate over the sampled window (1000 / mean interval). */
  fps: number;
  budgetMs: number;
  /** Inter-frame interval distribution (what the player feels), milliseconds. */
  avgFrameMs: number;
  p50FrameMs: number;
  p95FrameMs: number;
  p99FrameMs: number;
  maxFrameMs: number;
  /** Frames whose interval exceeded `budgetMs * 1.5` — visible hitches. */
  longFrames: number;
  /** Per-frame JavaScript CPU cost (sim + sync + render submit), milliseconds. */
  avgCpuMs: number;
  p95CpuMs: number;
  p99CpuMs: number;
  maxCpuMs: number;
  /** True when CPU work comfortably fits the frame budget with a tight tail. */
  cpuWithinBudget: boolean;
  /** Optional renderer-supplied gauges (e.g. live pixel ratio / detected refresh). */
  info?: Record<string, number>;
}

const CAP = 4096;

class Ring {
  private readonly buf = new Float64Array(CAP);
  private head = 0;
  private count = 0;

  push(v: number): void {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % CAP;
    if (this.count < CAP) this.count += 1;
  }

  reset(): void {
    this.head = 0;
    this.count = 0;
  }

  get size(): number {
    return this.count;
  }

  /** Copy the live samples into a fresh sorted array (allocates — summary only). */
  sorted(): Float64Array {
    const out = this.buf.slice(0, this.count);
    out.sort();
    return out;
  }
}

function pct(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

function mean(sorted: Float64Array): number {
  if (sorted.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < sorted.length; i += 1) s += sorted[i];
  return s / sorted.length;
}

export class FrameProfiler {
  private readonly intervals = new Ring();
  private readonly cpu = new Ring();
  private lastFrameMs = 0;
  private cpuStart = 0;
  private infoProvider: (() => Record<string, number>) | null = null;
  budgetMs: number;

  constructor(budgetMs: number = 1000 / 120) {
    this.budgetMs = budgetMs;
  }

  /** Register a callback supplying live renderer gauges to include in summaries. */
  setInfoProvider(fn: () => Record<string, number>): void {
    this.infoProvider = fn;
  }

  /** Call once at the very top of every animation frame. */
  frameStart(now: number): void {
    if (this.lastFrameMs > 0) this.intervals.push(now - this.lastFrameMs);
    this.lastFrameMs = now;
  }

  /** Bracket the per-frame JS work (sim + sync + render submit). */
  cpuBegin(now: number): void {
    this.cpuStart = now;
  }

  cpuEnd(now: number): void {
    if (this.cpuStart > 0) this.cpu.push(now - this.cpuStart);
  }

  reset(): void {
    this.intervals.reset();
    this.cpu.reset();
    this.lastFrameMs = 0;
    this.cpuStart = 0;
  }

  summary(): FrameStats {
    const iv = this.intervals.sorted();
    const cp = this.cpu.sorted();
    const avgFrameMs = mean(iv);
    const p99CpuMs = pct(cp, 99);
    return {
      frames: iv.length,
      fps: avgFrameMs > 0 ? 1000 / avgFrameMs : 0,
      budgetMs: this.budgetMs,
      avgFrameMs,
      p50FrameMs: pct(iv, 50),
      p95FrameMs: pct(iv, 95),
      p99FrameMs: pct(iv, 99),
      maxFrameMs: iv.length ? iv[iv.length - 1] : 0,
      longFrames: iv.reduce((n, v) => (v > this.budgetMs * 1.5 ? n + 1 : n), 0),
      avgCpuMs: mean(cp),
      p95CpuMs: pct(cp, 95),
      p99CpuMs,
      maxCpuMs: cp.length ? cp[cp.length - 1] : 0,
      cpuWithinBudget: cp.length > 0 && p99CpuMs <= this.budgetMs,
      info: this.infoProvider ? this.infoProvider() : undefined,
    };
  }
}

/**
 * Install a single shared profiler and expose it on `window.__perf` for headless
 * perf probes and manual inspection. Returns the instance so the caller can
 * bracket its frame loop. Safe to call in non-DOM contexts (no-op window hook).
 */
export function installFrameProfiler(budgetMs?: number): FrameProfiler {
  const profiler = new FrameProfiler(budgetMs);
  try {
    const w = globalThis as unknown as {
      __perf?: {
        summary: () => FrameStats;
        reset: () => void;
        setBudgetMs: (ms: number) => void;
      };
    };
    w.__perf = {
      summary: () => profiler.summary(),
      reset: () => profiler.reset(),
      setBudgetMs: (ms: number) => {
        profiler.budgetMs = ms;
      },
    };
  } catch {
    // Non-DOM / locked-down global: profiler still works for the caller.
  }
  return profiler;
}
