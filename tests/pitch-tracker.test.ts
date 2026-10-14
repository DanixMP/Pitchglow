import { describe, expect, it } from 'vitest';
import { PitchTracker, type PitchFrame } from '../src/audio/pitch-tracker';
import { freqToMidi } from '../src/dsp/notes';
import { noise, sawtooth } from './signals';

const SR = 48000;

function track(signal: Float32Array, blockSize = 512): PitchFrame[] {
  const frames: PitchFrame[] = [];
  const tracker = new PitchTracker(SR, (f) => frames.push(f));
  for (let i = 0; i < signal.length; i += blockSize) tracker.push(signal.subarray(i, i + blockSize));
  return frames;
}

describe('PitchTracker', () => {
  it('emits ~100 frames per second', () => {
    const frames = track(sawtooth(150, SR, 2));
    expect(frames.length).toBeGreaterThan(190);
    expect(frames.length).toBeLessThan(201);
    const dt = frames[11].time - frames[10].time;
    expect(dt).toBeCloseTo(0.01, 3);
  });

  it('tracks a steady voice-like tone', () => {
    const frames = track(sawtooth(150, SR, 1));
    const expected = freqToMidi(150);
    for (const f of frames) {
      expect(f.midi).not.toBeNull();
      expect(Math.abs(f.midi! - expected)).toBeLessThan(0.05); // within 5 cents
    }
  });

  it('follows a jump between notes', () => {
    const signal = new Float32Array(SR);
    signal.set(sawtooth(110, SR, 0.5));
    signal.set(sawtooth(165, SR, 0.5), SR / 2);
    const frames = track(signal);
    const late = frames.filter((f) => f.time > 0.7);
    expect(late.every((f) => Math.abs(f.midi! - freqToMidi(165)) < 0.1)).toBe(true);
  });

  it('marks silence and noise as unvoiced', () => {
    expect(track(new Float32Array(SR / 2)).every((f) => f.midi === null)).toBe(true);
    const noisy = track(noise(SR, 0.5));
    expect(noisy.filter((f) => f.midi !== null).length / noisy.length).toBeLessThan(0.1);
  });
});
