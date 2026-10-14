import { describe, expect, it, vi } from 'vitest';
import { harmonyText, listenModeText, retuneText, scaleText } from '../src/app/explain';
import { headingCardOf, processedLabelOf, processSettingsOf, tuneSettingsOf } from '../src/app/processing';
import { Store } from '../src/app/store';
import { DEFAULT_CLEANUP, DEFAULT_TUNING, type TuningPrefs } from '../src/storage/settings';

describe('Store', () => {
  it('merges patches and notifies with the previous state', () => {
    const s = new Store({ a: 1, b: 'x' });
    const seen: Array<[number, number]> = [];
    s.subscribe((state, prev) => seen.push([state.a, prev.a]));
    s.set({ a: 2 });
    s.set((st) => ({ a: st.a + 1 }));
    expect(s.get()).toEqual({ a: 3, b: 'x' });
    expect(seen).toEqual([
      [2, 1],
      [3, 2],
    ]);
  });

  it('watch fires immediately, then only when the selection changes', () => {
    const s = new Store({ a: 1, b: 1 });
    const cb = vi.fn();
    s.watch((st) => st.a, cb);
    s.set({ b: 2 });
    s.set({ a: 5 });
    expect(cb.mock.calls.map((c) => c[0])).toEqual([1, 5]);
  });

  it('shallow watch compares tuples element-wise', () => {
    const s = new Store({ a: 1, b: 1, c: 1 });
    const cb = vi.fn();
    s.watch((st) => [st.a, st.b] as const, cb, { shallow: true });
    s.set({ c: 9 });
    s.set({ b: 2 });
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('unsubscribes', () => {
    const s = new Store({ a: 1 });
    const cb = vi.fn();
    const off = s.watch((st) => st.a, cb);
    off();
    s.set({ a: 2 });
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('processing helpers', () => {
  const tuning = (patch: Partial<TuningPrefs> = {}): TuningPrefs => ({ ...DEFAULT_TUNING, ...patch });

  it('builds tune settings only when enabled, with harmony when chosen', () => {
    expect(tuneSettingsOf(tuning({ enabled: false }))).toBeNull();
    expect(tuneSettingsOf(tuning())).toEqual({ scale: { root: 0, type: 'chromatic' }, retuneMs: 50 });
    expect(tuneSettingsOf(tuning({ harmony: ['thirdUp'], harmonyMix: 0.5 }))?.harmony).toEqual({ voices: ['thirdUp'], mix: 0.5 });
  });

  it('combines tuning and clean-up into process settings and labels', () => {
    const off = tuning({ enabled: false });
    expect(processSettingsOf(off, DEFAULT_CLEANUP)).toBeNull();
    expect(processSettingsOf(off, { ...DEFAULT_CLEANUP, denoise: true })).toEqual({ tune: null, denoise: { amountDb: 12 } });
    expect(processedLabelOf(tuning(), DEFAULT_CLEANUP)).toBe('Tuned');
    expect(processedLabelOf(off, { ...DEFAULT_CLEANUP, denoise: true })).toBe('Cleaned');
    expect(processedLabelOf(tuning(), { ...DEFAULT_CLEANUP, denoise: true })).toBe('Clean + tuned');
  });

  it('picks the video-style title card', () => {
    expect(headingCardOf(tuning({ enabled: false })).title).toBe('My voice');
    expect(headingCardOf(tuning()).title).toBe('On auto-tune');
    expect(headingCardOf(tuning({ type: 'major', root: 9 }))).toMatchObject({ eyebrow: 'Only', title: 'A major', tone: 'scale' });
    expect(headingCardOf(tuning({ harmony: ['fifthUp'] })).title).toBe('A harmonizer');
  });

  it('writes caption texts', () => {
    expect(retuneText(0)).toContain('robot');
    expect(retuneText(250)).toContain('glides');
    expect(scaleText(tuning({ type: 'minor', root: 2 }))).toBe('Only D minor: it can only land on these notes.');
    expect(harmonyText(tuning())).toContain('off');
    expect(listenModeText(false, tuning(), DEFAULT_CLEANUP)).toContain('Original');
  });
});
