import { describe, expect, it } from 'vitest';
import { defaultDetents, dragValue, fillOrigin, parseDetents, ratioOf, snapToDetent, toStep, valueAt } from '../src/ui/slider-math';

const fader = { min: -40, max: 6, step: 0.5 };
const pan = { min: -100, max: 100, step: 1 };
const send = { min: 0, max: 100, step: 1 };

describe('slider maths', () => {
  it('maps values and positions both ways', () => {
    expect(ratioOf(-40, fader)).toBe(0);
    expect(ratioOf(6, fader)).toBe(1);
    expect(valueAt(0.5, pan)).toBe(0);
    expect(ratioOf(500, send)).toBe(1); // clamped
  });

  it('rounds to the step grid without float noise', () => {
    expect(toStep(-3.26, fader)).toBe(-3.5);
    expect(toStep(0.30000000000000004, { min: 0, max: 1, step: 0.1 })).toBe(0.3);
    expect(toStep(7, fader)).toBe(6);
  });

  it('snaps to detents only when close (and never with Alt)', () => {
    expect(snapToDetent(0.9, [0], fader)).toBe(0); // within 2.5% of 46 dB
    expect(snapToDetent(1.5, [0], fader)).toBe(1.5);
    expect(snapToDetent(0.9, [0], fader, true)).toBe(0.9);
    expect(snapToDetent(-4, [0], pan)).toBe(0);
    expect(snapToDetent(-6, [0], pan)).toBe(-6);
  });

  it('finds detents: zero of a bipolar range, or data-detents', () => {
    expect(defaultDetents(fader)).toEqual([0]);
    expect(defaultDetents(send)).toEqual([]);
    expect(parseDetents(undefined, pan)).toEqual([0]);
    expect(parseDetents('60, 12, 999', send)).toEqual([60, 12]);
    expect(parseDetents('', pan)).toEqual([]);
  });

  it('fills from the centre for ranges around zero', () => {
    expect(fillOrigin(pan)).toBe(0.5);
    expect(fillOrigin(send)).toBe(0);
    expect(fillOrigin(fader)).toBeCloseTo(40 / 46, 6);
  });

  it('drags relative to the grab point, ten times finer with Shift', () => {
    expect(dragValue(0, 50, 200, pan, false)).toBe(50);
    expect(dragValue(0, 50, 200, pan, true)).toBe(5);
    expect(dragValue(10, -20, 200, send, false)).toBe(0);
  });
});
