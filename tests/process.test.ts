import { describe, expect, it } from 'vitest';
import { PitchTracker, type PitchFrame } from '../src/audio/pitch-tracker';
import { denoise } from '../src/dsp/denoise';
import { renderPlans, renderWithHarmony } from '../src/dsp/harmony';
import { processRecording } from '../src/dsp/process';
import { analyzePsola } from '../src/dsp/psola';
import { planVoices } from '../src/dsp/voice-engine';
import { CHROMATIC } from '../src/dsp/scales';
import { noise, sawtooth } from './signals';

const SR = 48000;

function take() {
  const x = new Float32Array(SR * 2);
  x.set(sawtooth(196, SR, 1.2, 0.25), SR * 0.5);
  const hiss = noise(SR, 2, 0.03);
  return x.map((v, i) => v + hiss[i]);
}

function track(x: Float32Array): PitchFrame[] {
  const frames: PitchFrame[] = [];
  const t = new PitchTracker(SR, (f) => frames.push(f));
  for (let i = 0; i < x.length; i += 512) t.push(x.subarray(i, i + 512));
  return frames;
}

describe('processRecording', () => {
  const x = take();
  const frames = track(x);
  const tune = { scale: CHROMATIC, retuneMs: 0 };
  const den = { amountDb: 15 };

  it('denoise only = denoise()', () => {
    const { output } = processRecording(x, SR, frames, { denoise: den, tune: null });
    const expected = denoise(x, SR, den).output;
    expect(output[SR]).toBeCloseTo(expected[SR], 6);
  });

  it('tune only = renderWithHarmony() on the original', () => {
    const { output } = processRecording(x, SR, frames, { denoise: null, tune });
    expect(output[SR]).toBeCloseTo(renderWithHarmony(x, SR, frames, tune)[SR], 6);
  });

  it('cleans first, then tunes the cleaned audio (with marks from the original)', () => {
    const a = processRecording(x, SR, frames, { denoise: den, tune });
    const plans = planVoices(analyzePsola(x, SR, frames), frames, tune, 0)!;
    expect(a.output).toEqual(renderPlans(denoise(x, SR, den).output, plans, SR));
  });

  it('reports when there is too little audio to learn the noise', () => {
    const short = x.subarray(0, 4000);
    const r = processRecording(short, SR, [], { denoise: den, tune: null });
    expect(r.notes).toEqual(['Too short to learn the noise']);
  });

  it('transposes without auto-tune (track pitch / key shift)', () => {
    const clean = sawtooth(196, SR, 1.2, 0.25);
    const f = track(clean);
    const { output } = processRecording(clean, SR, f, { denoise: null, tune: null, pitch: 5 });
    const m = track(output).filter((x) => x.midi !== null && x.time > 0.2 && x.time < 1).map((x) => x.midi!).sort((a, b) => a - b);
    expect(m[m.length >> 1] - 12 * Math.log2(196 / 440) - 69).toBeCloseTo(5, 1);
  });

  it('moves harmony voices with the key shift', () => {
    const clean = sawtooth(261.63, SR, 1.2, 0.15); // C4
    const f = track(clean);
    const shifted = processRecording(clean, SR, f, {
      denoise: null,
      tune: { scale: { root: 0, type: 'major' }, retuneMs: 0, harmony: { voices: ['octaveUp'], mix: 1 } },
      pitch: 2,
    }).output;
    // Strongest pitch is the lead at D4 (+2); the octave voice sits at D5 — both moved.
    const m = track(shifted).filter((x) => x.midi !== null && x.time > 0.2 && x.time < 1).map((x) => x.midi!).sort((a, b) => a - b);
    expect(Math.round(m[m.length >> 1])).toBe(62);
  });
});
