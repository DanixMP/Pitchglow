// Metronome clicks (Phase 17, pure): a generator that clicks on the beats of whatever song positions
// it is asked for, so it follows seeks and loop wraps sample-accurately, the same way the voice
// engine does. Bar downbeats can be accented (higher, louder click).

export interface ClickGrid {
  /** Beat length in samples (fractional). */
  beatSamples: number;
  /** Song sample of a bar's first beat. */
  downbeatSample: number;
  beatsPerBar: number;
  /** Accent the first beat of each bar. */
  accent: boolean;
}

const CLICK_SECONDS = 0.045;

/** A short, decaying sine "tick" with a 0.5 ms attack. */
function makeClick(sampleRate: number, hz: number, level: number): Float32Array {
  const n = Math.round(CLICK_SECONDS * sampleRate);
  const out = new Float32Array(n);
  const attack = Math.max(1, Math.round(0.0005 * sampleRate));
  const tau = 0.009 * sampleRate;
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / attack) * Math.exp(-i / tau) * (1 - i / n);
    out[i] = level * env * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  }
  return out;
}

export class ClickTrack {
  private readonly accentClick: Float32Array;
  private readonly beatClick: Float32Array;
  private grid: ClickGrid;
  /** The click being played and how far into it (it carries on across blocks and runs). */
  private voice: Float32Array | null = null;
  private pos = 0;

  constructor(sampleRate: number, grid: ClickGrid) {
    this.accentClick = makeClick(sampleRate, 1760, 0.9);
    this.beatClick = makeClick(sampleRate, 1175, 0.6);
    this.grid = grid;
  }

  setGrid(grid: ClickGrid): void {
    this.grid = grid;
  }

  /** Silences a click in progress (transport stopped or restarted). */
  reset(): void {
    this.voice = null;
    this.pos = 0;
  }

  /** Song sample at which beat `k` clicks (the first sample at or after the exact beat time). */
  beatSample(k: number): number {
    return Math.ceil(this.grid.downbeatSample + k * this.grid.beatSamples - 1e-6);
  }

  /**
   * Adds clicks for song samples [songStart, songStart + len) into out[at …]. Beats at or after
   * `before` (song samples) don't click (a count-in with the metronome off). Consecutive calls must
   * cover consecutive output samples (a click in progress continues).
   */
  render(out: Float32Array, at: number, songStart: number, len: number, before = Infinity): void {
    const g = this.grid;
    // First beat whose click sample is >= songStart.
    let k = Math.floor((songStart - 1 - g.downbeatSample) / g.beatSamples) + 1;
    while (this.beatSample(k) < songStart) k++;
    while (this.beatSample(k - 1) >= songStart) k--;
    let next = this.beatSample(k);
    for (let i = 0; i < len; i++) {
      const p = songStart + i;
      if (p === next) {
        if (p < before) {
          const onBar = ((k % g.beatsPerBar) + g.beatsPerBar) % g.beatsPerBar === 0;
          this.voice = onBar && g.accent ? this.accentClick : this.beatClick;
          this.pos = 0;
        }
        k++;
        next = this.beatSample(k);
      }
      const v = this.voice;
      if (v) {
        out[at + i] += v[this.pos++];
        if (this.pos >= v.length) this.voice = null;
      }
    }
  }
}
