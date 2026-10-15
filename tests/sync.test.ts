import { describe, expect, it } from 'vitest';
import { alignTake, detectClickLatency } from '../src/audio/sync';
import { noise } from './signals';

describe('alignTake', () => {
  it('puts a take that started with the song at song position minus the round trip', () => {
    // Song plays from 0 at t=10; take's first sample at t=10; 30 ms out + 15 ms in.
    expect(alignTake({ playStart: 10, songPosition: 0, firstSampleTime: 10, outputLatency: 0.03, inputLatency: 0.015 })).toBeCloseTo(-0.045, 9);
  });

  it('accounts for playing from the middle and a late first block', () => {
    const off = alignTake({ playStart: 5, songPosition: 12, firstSampleTime: 5.02, outputLatency: 0.02, inputLatency: 0.01 });
    expect(off).toBeCloseTo(12 + 0.02 - 0.03, 9);
  });

  it('places a count-in before the song (negative offset) and applies the nudge', () => {
    // Recording began 2 s (one bar at 120 BPM) before the song started at position 0.
    const off = alignTake({ playStart: 3, songPosition: 0, firstSampleTime: 1, outputLatency: 0, inputLatency: 0, nudge: 0.01 });
    expect(off).toBeCloseTo(-2 + 0.01, 9);
  });

  it('is exact for a simulated performance', () => {
    // Simulate: a singer hits song position 4.000 exactly as heard; where does it land on the track?
    const playStart = 100;
    const outL = 0.042;
    const inL = 0.011;
    const firstSampleTime = 99.5; // capture started half a second before playback
    const offset = alignTake({ playStart, songPosition: 0, firstSampleTime, outputLatency: outL, inputLatency: inL });
    const heardAt = playStart + 4 + outL; // when song pos 4 is heard
    const capturedAt = heardAt + inL; // when the singer's response is processed
    const sampleTimeInTake = capturedAt - firstSampleTime;
    expect(offset + sampleTimeInTake).toBeCloseTo(4, 9);
  });
});

describe('detectClickLatency', () => {
  const SR = 48000;

  function recordClicks(clickTimes: number[], startTime: number, delay: number, seconds: number, roomNoise = 0.003) {
    const x = noise(SR, seconds, roomNoise);
    for (const t of clickTimes) {
      const s0 = Math.round((t + delay - startTime) * SR);
      for (let i = 0; i < 240 && s0 + i < x.length; i++) x[s0 + i] += 0.5 * Math.exp(-i / 60) * (i % 2 ? 1 : -1);
    }
    return x;
  }

  it('measures the round trip to within a millisecond', () => {
    const clicks = [1, 1.4, 1.8, 2.2, 2.6, 3.0];
    const x = recordClicks(clicks, 0.5, 0.087, 3.5);
    const r = detectClickLatency(x, 0.5, SR, clicks);
    expect(r).not.toBeNull();
    expect(Math.abs(r! - 0.087)).toBeLessThan(0.001);
  });

  it('ignores a missed click (median)', () => {
    const clicks = [1, 1.4, 1.8, 2.2, 2.6];
    const x = recordClicks([1, 1.4, 2.2, 2.6], 0, 0.12, 3.2); // the 1.8 s click never arrived
    expect(Math.abs(detectClickLatency(x, 0, SR, clicks)! - 0.12)).toBeLessThan(0.001);
  });

  it('gives up when nothing was heard (headphones on)', () => {
    expect(detectClickLatency(noise(SR, 3, 0.003), 0, SR, [1, 1.4, 1.8, 2.2])).toBeNull();
  });
});
