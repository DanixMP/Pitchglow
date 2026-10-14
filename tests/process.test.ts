import { describe, expect, it } from 'vitest';
import { PitchTracker, type PitchFrame } from '../src/audio/pitch-tracker';
import { denoise } from '../src/dsp/denoise';
import { renderWithHarmony } from '../src/dsp/harmony';
import { processRecording, type DenoiseCache } from '../src/dsp/process';
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

  it('chains denoise then tune, and reuses the cached denoise', () => {
    let computed = 0;
    let entry: DenoiseCache | undefined;
    const cache = {
      get: (k: string) => (entry?.key === k ? entry : undefined),
      set: (e: DenoiseCache) => {
        computed++;
        entry = e;
      },
    };
    const a = processRecording(x, SR, frames, { denoise: den, tune }, cache, 'rec-1');
    const b = processRecording(x, SR, frames, { denoise: den, tune: { ...tune, retuneMs: 80 } }, cache, 'rec-1');
    expect(computed).toBe(1); // second render reused the cleaned audio
    const cleanedThenTuned = renderWithHarmony(denoise(x, SR, den).output, SR, frames, tune);
    expect(a.output[SR]).toBeCloseTo(cleanedThenTuned[SR], 6);
    expect(b.output.length).toBe(x.length);
    processRecording(x, SR, frames, { denoise: den, tune }, cache, 'rec-2');
    expect(computed).toBe(2); // different recording -> recomputed
  });

  it('reports when there is too little audio to learn the noise', () => {
    const short = x.subarray(0, 4000);
    const r = processRecording(short, SR, [], { denoise: den, tune: null });
    expect(r.notes).toEqual(['Too short to learn the noise']);
  });
});
