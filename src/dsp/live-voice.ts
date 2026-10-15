// Live voice (Phase 14): hear yourself auto-tuned while you sing. A causal version of the PSOLA
// pipeline, fed block by block from the mic, with a fixed delay of LIVE_DELAY_SECONDS.
//
// - The PitchTracker (the same one that draws the pitch line) runs on the incoming audio; each frame
//   goes through the PitchCorrector, giving the period and the pitch ratio for the lead and each
//   harmony voice at that moment (kept in a short history and interpolated).
// - Analysis marks are placed one per cycle on the peaks of a low-passed copy, as soon as a whole
//   cycle has arrived.
// - Synthesis runs `delay` samples behind the input: each synthesis grain copies the Hann-windowed
//   cycle around the nearest analysis mark that is already complete. Grains are capped at half the
//   delay, which covers voices down to ~80 Hz at full quality.
// - Unvoiced audio passes through the lead unchanged (identity grains); harmony voices only sing the
//   voiced parts, as in the playback engine.
// With nothing to do (no tuning, no transpose) the input is passed straight through, with no delay.

import type { PitchFrame } from '../audio/pitch-tracker';
import { PitchTracker } from '../audio/pitch-tracker';
import { PitchCorrector, type TuneSettings } from './autotune';
import { harmonyNote } from './harmony';
import { midiToFreq } from './notes';
import { GrainShaper, SHAPE_MAX_HALF, type GrainVoice } from './grain-shape';
import { hann, normalizeGrain } from './psola';
import { nearestInScale, scaleMask } from './scales';
import { grainVoice, isNeutralVoice, type VoiceCharacter } from './voice-engine';

/** Extra latency of the live path when it processes (the analysis needs one cycle ahead). */
export const LIVE_DELAY_SECONDS = 0.025;
export const MAX_HARMONIES = 6;

const RING = 1 << 15;
const MASK = RING - 1;
const FRAMES = 64;
const MAX_MARKS = 1024;
const MARK_SEARCH = 0.3;
const UNVOICED_SECONDS = 0.005;

export interface LiveSettings {
  tune: TuneSettings | null;
  /** Transpose (e.g. the song's key shift), semitones. */
  semitones: number;
  /** Voice character (formant, whisper, robot); null = natural. */
  voice?: VoiceCharacter | null;
}

export class LiveVoice {
  /** Delay of the processed output, samples. */
  readonly delay: number;
  /** Harmony voices allowed (lowered automatically under CPU load). */
  maxHarmonies = MAX_HARMONIES;
  /** Every pitch frame, with its sample position (since the voice started). */
  onFrame: ((frame: PitchFrame, position: number) => void) | null = null;

  private readonly sampleRate: number;
  private readonly hCap: number;
  private readonly unvoiced: number;
  private readonly tracker: PitchTracker;
  private settings: LiveSettings = { tune: null, semitones: 0 };
  private corrector: PitchCorrector | null = null;
  private harmonies = 0;
  private harmonyGain = 0;
  // Voice character.
  private readonly shaper = new GrainShaper();
  private readonly grainVoices: GrainVoice[] = [];
  private shaping = false;
  private monotone = false;
  private monoNote: number | null = null;
  private scaleMask: boolean[] | null = null;
  private grainCount = 0;

  private readonly x = new Float32Array(RING);
  private readonly lp = new Float32Array(RING);
  private readonly acc: Float32Array[];
  private readonly wsum: Float32Array[];
  /** Samples received so far. */
  private n = 0;

  // Pitch history: frame centre (samples), period (samples; 0 = unvoiced), pitch ratio per voice.
  private readonly fPos = new Float64Array(FRAMES);
  private readonly fPeriod = new Float64Array(FRAMES);
  private readonly fRatio: Float64Array[];
  private fCount = 0;
  private fHead = 0;

  // Analysis marks (sample positions).
  private readonly marks = new Float64Array(MAX_MARKS);
  private markCount = 0;
  private markHead = 0;
  private lastMark = -1;
  private searchFrom = 0;

  /** Next synthesis position per voice (0 = lead). */
  private readonly synth: Float64Array;

  // Causal biquad low-pass (900 Hz) for the analysis marks.
  private readonly b0: number;
  private readonly b1: number;
  private readonly b2: number;
  private readonly a1: number;
  private readonly a2: number;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.delay = Math.round(sampleRate * LIVE_DELAY_SECONDS);
    this.hCap = Math.floor(this.delay / 2);
    this.unvoiced = Math.max(16, Math.round(sampleRate * UNVOICED_SECONDS));
    this.acc = Array.from({ length: 1 + MAX_HARMONIES }, () => new Float32Array(RING));
    this.wsum = Array.from({ length: 1 + MAX_HARMONIES }, () => new Float32Array(RING));
    this.fRatio = Array.from({ length: 1 + MAX_HARMONIES }, () => new Float64Array(FRAMES));
    this.synth = new Float64Array(1 + MAX_HARMONIES);
    this.tracker = new PitchTracker(sampleRate, (f) => this.frame(f));

    const w0 = (2 * Math.PI * 900) / sampleRate;
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
    const cos = Math.cos(w0);
    const a0 = 1 + alpha;
    this.b0 = (1 - cos) / 2 / a0;
    this.b1 = (1 - cos) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  setSettings(settings: LiveSettings): void {
    this.settings = settings;
    this.corrector = settings.tune ? new PitchCorrector(settings.tune) : null;
    const v = settings.voice;
    this.shaping = !!v && (v.formant !== 0 || v.whisper > 0);
    this.monotone = !!v?.monotone;
    this.monoNote = null;
    this.scaleMask = settings.tune ? scaleMask(settings.tune.scale) : null;
    for (let i = 0; i <= MAX_HARMONIES; i++) this.grainVoices[i] = grainVoice(v ?? { formant: 0, whisper: 0, monotone: false }, i);
    const wanted = Math.min(settings.tune?.harmony?.voices.length ?? 0, MAX_HARMONIES);
    this.setHarmonies(wanted);
  }

  /** Whether the output is processed (delayed) rather than the input passed straight through. */
  get processing(): boolean {
    return this.settings.tune !== null || this.settings.semitones !== 0 || !isNeutralVoice(this.settings.voice);
  }

  /** Processes one block (any size up to a few thousand samples) of input into output. */
  process(input: Float32Array, output: Float32Array): void {
    const len = input.length;
    const start = this.n;
    for (let i = 0; i < len; i++) {
      const v = input[i];
      const y = this.b0 * v + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1;
      this.x1 = v;
      this.y2 = this.y1;
      this.y1 = y;
      this.x[(start + i) & MASK] = v;
      this.lp[(start + i) & MASK] = y;
    }
    this.n += len;
    this.tracker.push(input);

    if (!this.processing) {
      output.set(input);
      // Keep the synthesis in step, so switching on starts cleanly.
      for (let v = 0; v <= MAX_HARMONIES; v++) this.synth[v] = this.n - this.delay;
      this.lastMark = -1;
      this.searchFrom = this.n;
      return;
    }

    this.updateMarks();
    const outEnd = this.n - this.delay;
    const outStart = outEnd - len;
    const voices = Math.min(this.harmonies, this.maxHarmonies);
    for (let v = 0; v <= voices; v++) this.synthesize(v, outStart, outEnd);

    const gain = this.harmonyGain;
    for (let i = 0; i < len; i++) {
      const p = outStart + i;
      if (p < 0) {
        output[i] = 0;
        continue;
      }
      const k = p & MASK;
      let y = normalizeGrain(this.acc[0][k], this.wsum[0][k], this.x[k], true);
      this.acc[0][k] = 0;
      this.wsum[0][k] = 0;
      for (let v = 1; v <= voices; v++) {
        y += gain * normalizeGrain(this.acc[v][k], this.wsum[v][k], 0, false);
        this.acc[v][k] = 0;
        this.wsum[v][k] = 0;
      }
      output[i] = y;
    }
  }

  // --- pitch frames --------------------------------------------------------------------------

  private frame(f: PitchFrame): void {
    const pos = f.time * this.sampleRate;
    const i = this.fHead;
    this.fHead = (this.fHead + 1) % FRAMES;
    if (this.fCount < FRAMES) this.fCount++;
    this.fPos[i] = pos;
    const midi = f.midi;
    let c = this.corrector?.process(f) ?? null;
    if (this.monotone) {
      // Robot: hold each phrase on the note it starts on (as monotoneCorrections does offline).
      if (midi === null) this.monoNote = null;
      else this.monoNote ??= this.settings.tune && this.scaleMask ? nearestInScale(midi, this.settings.tune.scale, this.scaleMask) : Math.round(midi);
      c = this.monoNote === null ? null : { target: this.monoNote, corrected: this.monoNote };
    }
    if (midi === null) {
      this.fPeriod[i] = 0;
      for (let v = 0; v <= MAX_HARMONIES; v++) this.fRatio[v][i] = 1;
    } else {
      this.fPeriod[i] = this.sampleRate / midiToFreq(midi);
      const corrected = (c?.corrected ?? midi) + this.settings.semitones;
      this.fRatio[0][i] = Math.pow(2, (corrected - midi) / 12);
      const tune = this.settings.tune;
      const voices = tune?.harmony?.voices ?? [];
      for (let v = 1; v <= MAX_HARMONIES; v++) {
        const voice = voices[v - 1];
        if (!voice || !tune || c?.target === null || c?.target === undefined) {
          this.fRatio[v][i] = this.fRatio[0][i];
          continue;
        }
        const h = harmonyNote(c.target, voice, tune.scale);
        this.fRatio[v][i] = Math.pow(2, (corrected + (h - c.target) - midi) / 12);
      }
    }
    this.onFrame?.(f, pos);
  }

  /** Index of the newest frame at or before `t`, or -1 when `t` is before all frames. */
  private frameAt(t: number): number {
    for (let j = 0; j < this.fCount; j++) {
      const i = (this.fHead - 1 - j + FRAMES) % FRAMES;
      if (this.fPos[i] <= t) return i;
    }
    return -1;
  }

  /** Period (samples) at position t; 0 = unvoiced. Holds the newest frame beyond it. */
  private periodAt(t: number): number {
    if (this.fCount === 0) return 0;
    const i = this.frameAt(t);
    if (i < 0) return 0;
    const next = (i + 1) % FRAMES;
    const newest = (this.fHead - 1 + FRAMES) % FRAMES;
    if (i === newest) return this.fPeriod[i];
    const a = this.fPeriod[i];
    const b = this.fPeriod[next];
    if (a === 0 || b === 0) return t - this.fPos[i] < this.fPos[next] - t ? a : b;
    return a + ((b - a) * (t - this.fPos[i])) / (this.fPos[next] - this.fPos[i]);
  }

  private ratioAt(v: number, t: number): number {
    const i = this.frameAt(t);
    if (i < 0) return 1;
    const next = (i + 1) % FRAMES;
    const newest = (this.fHead - 1 + FRAMES) % FRAMES;
    const r = this.fRatio[v];
    if (i === newest) return r[i];
    return r[i] + ((r[next] - r[i]) * (t - this.fPos[i])) / (this.fPos[next] - this.fPos[i]);
  }

  private newestFrame(): number {
    return this.fCount ? this.fPos[(this.fHead - 1 + FRAMES) % FRAMES] : -1;
  }

  // --- analysis marks ---------------------------------------------------------------------------

  private updateMarks(): void {
    const n = this.n;
    // Never look back further than the synthesis can still use.
    const floor = n - this.delay - 4 * this.hCap;
    if (this.searchFrom < floor) this.searchFrom = floor;
    if (this.lastMark >= 0 && this.lastMark < floor) this.lastMark = -1;
    const known = this.newestFrame();
    for (let guard = 0; guard < 4096; guard++) {
      if (this.lastMark < 0) {
        // Find where the voice starts (only as far as the pitch frames reach).
        let p = this.searchFrom;
        while (p < known && this.periodAt(p) === 0) p += this.unvoiced;
        this.searchFrom = p;
        const T = this.periodAt(p);
        if (T === 0 || p + T >= n) return;
        this.pushMark(this.argmax(p, Math.round(p + T)));
        continue;
      }
      const T = this.periodAt(this.lastMark);
      if (T === 0) {
        this.searchFrom = this.lastMark + this.unvoiced;
        this.lastMark = -1;
        continue;
      }
      const predicted = this.lastMark + T;
      const lo = Math.max(this.lastMark + 1, Math.round(predicted - MARK_SEARCH * T));
      const hi = Math.round(predicted + MARK_SEARCH * T);
      if (hi >= n) return; // wait for the whole next cycle
      this.pushMark(this.argmax(lo, hi + 1));
    }
  }

  private pushMark(m: number): void {
    this.marks[this.markHead] = m;
    this.markHead = (this.markHead + 1) % MAX_MARKS;
    if (this.markCount < MAX_MARKS) this.markCount++;
    this.lastMark = m;
  }

  private argmax(from: number, to: number): number {
    let best = from;
    let bestValue = -Infinity;
    for (let i = from; i < to; i++) {
      const v = this.lp[i & MASK];
      if (v > bestValue) {
        bestValue = v;
        best = i;
      }
    }
    return best;
  }

  /** The analysis mark nearest to t whose grain (half h) is complete, within one period; or -1. */
  private nearestMark(t: number, h: number, T: number): number {
    let best = -1;
    let bestDist = T;
    for (let j = 0; j < this.markCount; j++) {
      const m = this.marks[(this.markHead - 1 - j + MAX_MARKS) % MAX_MARKS];
      if (m < t - 2 * T) break;
      if (m + h > this.n) continue;
      const d = Math.abs(m - t);
      if (d <= bestDist) {
        bestDist = d;
        best = m;
      }
    }
    return best;
  }

  // --- synthesis --------------------------------------------------------------------------------

  private synthesize(v: number, outStart: number, outEnd: number): void {
    const acc = this.acc[v];
    const wsum = this.wsum[v];
    const hCap = this.hCap;
    if (this.synth[v] < outStart - hCap) this.synth[v] = outStart; // fell behind (e.g. just switched on)
    while (this.synth[v] - hCap < outEnd) {
      const ts = this.synth[v];
      const T = this.periodAt(ts);
      if (T > 0) {
        const Ts = T / this.ratioAt(v, ts);
        const h = Math.min(hCap, Math.round(T)); // two analysis periods, as in psola.ts
        const gv = this.grainVoices[v];
        const shaped = this.shaping && h <= SHAPE_MAX_HALF;
        // A formant shift up reads further ahead: allow a mark a cycle further back.
        const reach = shaped ? Math.ceil(h * Math.max(1, gv.formant)) + 1 : h;
        const a = this.nearestMark(ts, reach, shaped ? 2 * T : T);
        if (a >= 0) {
          if (shaped) {
            const grain = this.shaper.shape(this.x, a, h, gv, this.grainCount++, this.n - RING + 1, this.n, MASK);
            this.overlapShaped(acc, wsum, grain, Math.round(ts), h, outStart);
          } else {
            this.overlapAdd(acc, wsum, a, Math.round(ts), h, outStart);
          }
          this.synth[v] = ts + Math.max(1, Ts);
          continue;
        }
      }
      if (v === 0) {
        const at = Math.round(ts);
        this.overlapAdd(acc, wsum, at, at, this.unvoiced, outStart);
      }
      this.synth[v] = ts + this.unvoiced;
    }
  }

  /** Overlap-adds an already shaped grain (grain[k + half]) centred on `to`. */
  private overlapShaped(acc: Float32Array, wsum: Float32Array, grain: Float32Array, to: number, half: number, outStart: number): void {
    for (let k = Math.max(-half + 1, outStart - to); k <= half - 1; k++) {
      const w = hann(k, half);
      const o = (to + k) & MASK;
      acc[o] += w * grain[k + half];
      wsum[o] += w;
    }
  }

  private overlapAdd(acc: Float32Array, wsum: Float32Array, from: number, to: number, half: number, outStart: number): void {
    const kMin = Math.max(-half + 1, outStart - to, this.n - RING - from);
    const kMax = Math.min(half - 1, this.n - 1 - from);
    for (let k = kMin; k <= kMax; k++) {
      const w = hann(k, half);
      const o = (to + k) & MASK;
      acc[o] += w * this.x[(from + k) & MASK];
      wsum[o] += w;
    }
  }

  private setHarmonies(count: number): void {
    if (count > this.harmonies) {
      // Newly active voices start clean, in step with the lead.
      for (let v = this.harmonies + 1; v <= count; v++) {
        this.acc[v].fill(0);
        this.wsum[v].fill(0);
        this.synth[v] = this.synth[0];
      }
    }
    this.harmonies = count;
    const mix = this.settings.tune?.harmony?.mix ?? 0.6;
    this.harmonyGain = count ? mix / Math.sqrt(count) : 0;
  }
}
