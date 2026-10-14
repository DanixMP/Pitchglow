// Turns a stream of raw sample blocks into ~100 pitch frames per second.
// Pure (no Web Audio), so it can be unit-tested with synthesized signals.

import { Decimator, decimationFactor } from '../dsp/resample';
import { Yin } from '../dsp/yin';
import { freqToMidi } from '../dsp/notes';

export interface PitchFrame {
  /** Seconds since the tracker started (centre of the analysis window). */
  time: number;
  /** Detected fundamental in Hz, or null when unvoiced/silent. */
  freq: number | null;
  /** Fractional MIDI note (after smoothing), or null when unvoiced/silent. */
  midi: number | null;
  clarity: number;
  /** RMS level of the analysis window (0..1). */
  rms: number;
}

export interface PitchTrackerOptions {
  /** Analysis sample rate to decimate towards. */
  analysisRate?: number;
  /** Seconds between frames. */
  hopSeconds?: number;
  /** Below this RMS the frame counts as silence. */
  minRms?: number;
  /** Below this clarity the frame counts as unvoiced (breath, "s", noise). */
  minClarity?: number;
}

export class PitchTracker {
  readonly analysisRate: number;
  minRms: number;
  minClarity: number;

  private readonly decimator: Decimator;
  private readonly yin: Yin;
  private readonly ring: Float32Array;
  private readonly frame: Float32Array;
  private readonly hop: number;
  private writePos = 0;
  private filled = 0;
  private sinceHop = 0;
  private total = 0;
  /** Last raw MIDI values for the median-of-3 filter. */
  private recent: (number | null)[] = [null, null, null];

  constructor(
    inputRate: number,
    private readonly onFrame: (frame: PitchFrame) => void,
    opts: PitchTrackerOptions = {},
  ) {
    const { analysisRate = 22050, hopSeconds = 0.01, minRms = 0.008, minClarity = 0.7 } = opts;
    this.decimator = new Decimator(inputRate, decimationFactor(inputRate, analysisRate));
    this.analysisRate = this.decimator.outputRate;
    this.yin = new Yin(this.analysisRate);
    this.ring = new Float32Array(this.yin.frameLength);
    this.frame = new Float32Array(this.yin.frameLength);
    this.hop = Math.max(1, Math.round(this.analysisRate * hopSeconds));
    this.minRms = minRms;
    this.minClarity = minClarity;
  }

  push(block: Float32Array): void {
    const samples = this.decimator.process(block);
    const len = this.ring.length;
    for (let i = 0; i < samples.length; i++) {
      this.ring[this.writePos] = samples[i];
      this.writePos = (this.writePos + 1) % len;
      if (this.filled < len) this.filled++;
      this.total++;
      if (++this.sinceHop >= this.hop && this.filled === len) {
        this.sinceHop = 0;
        this.analyze();
      }
    }
  }

  private analyze(): void {
    const { ring, frame } = this;
    // Unroll the ring buffer, oldest sample first.
    const head = ring.length - this.writePos;
    frame.set(ring.subarray(this.writePos), 0);
    frame.set(ring.subarray(0, this.writePos), head);

    let sumSq = 0;
    for (let i = 0; i < frame.length; i++) sumSq += frame[i] * frame[i];
    const rms = Math.sqrt(sumSq / frame.length);
    const time = (this.total - frame.length / 2) / this.analysisRate;

    const est = rms >= this.minRms ? this.yin.detect(frame) : null;
    const voiced = est !== null && est.clarity >= this.minClarity;
    const rawMidi = voiced ? freqToMidi(est.freq) : null;

    this.recent.shift();
    this.recent.push(rawMidi);
    const midi = rawMidi === null ? null : this.median(rawMidi);

    this.onFrame({ time, freq: voiced ? est.freq : null, midi, clarity: est?.clarity ?? 0, rms });
  }

  /** Median of the last three voiced values; removes one-frame octave spikes. */
  private median(current: number): number {
    const [a, b] = this.recent;
    if (a === null || b === null) return current;
    return Math.max(Math.min(a, b), Math.min(Math.max(a, b), current));
  }
}
