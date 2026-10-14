// Canvas piano roll: keyboard on the left, one coloured lane per semitone, and a glowing pitch line
// that scrolls left into a fixed "now" playhead (Goal.mp4, 0:00-0:20).

import type { PitchFrame } from '../audio/pitch-tracker';
import { isBlackKey, octaveOf, pitchClass } from '../dsp/notes';
import { laneFill, litColor, theme } from './colors';

export interface PianoRollOptions {
  /** Seconds of history between the keyboard and the playhead. */
  secondsVisible?: number;
  /** Playhead position as a fraction of the lane area width. */
  playheadRatio?: number;
}

const LOWEST_NOTE = 24; // C1
const HIGHEST_NOTE = 96; // C7
/** Frames further apart than this are drawn as separate strokes. */
const MAX_GAP_SECONDS = 0.04;
/** Jumps bigger than this between consecutive frames are treated as a break, not a glide. */
const MAX_JUMP_SEMITONES = 10;

export class PianoRoll {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly secondsVisible: number;
  private readonly playheadRatio: number;

  /** Live: frames stream in and old ones are dropped. Otherwise the picture follows `cursor`. */
  private frames: PitchFrame[] = [];
  private latestTime = 0;
  private lastPushAt = 0;
  private live = false;
  private cursor = 0;
  private duration = 0;
  private renderedAt = 0;

  private width = 0;
  private height = 0;
  private dpr = 1;

  private viewCenter = 52; // E3, middle of a typical speaking range
  private viewTarget = 52;
  private lit = new Map<number, number>();
  private lastRenderAt = 0;

  /** Called with a new time while the user drags a recording left/right. */
  onScrub: ((time: number) => void) | null = null;
  private drag: { pointerId: number; startX: number; startTime: number } | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    opts: PianoRollOptions = {},
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D not supported');
    this.ctx = ctx;
    this.secondsVisible = opts.secondsVisible ?? 4;
    this.playheadRatio = opts.playheadRatio ?? 0.72;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    this.attachScrubbing();
  }

  /** Clears the history and starts following a new live stream. */
  start(): void {
    this.frames = [];
    this.latestTime = 0;
    this.lastPushAt = performance.now();
    this.live = true;
    this.duration = 0;
  }

  /** Freezes the picture where it is. */
  stop(): void {
    this.live = false;
    this.cursor = this.latestTime;
  }

  push(frame: PitchFrame): void {
    this.frames.push(frame);
    this.latestTime = frame.time;
    this.lastPushAt = performance.now();
    const keepFrom = frame.time - this.secondsVisible - 1;
    let drop = 0;
    while (drop < this.frames.length && this.frames[drop].time < keepFrom) drop++;
    if (drop > 0) this.frames.splice(0, drop);
  }

  /** Shows a whole recorded pitch track; move through it with `setTime`. */
  showRecording(frames: PitchFrame[], duration: number, time = duration): void {
    this.live = false;
    this.frames = frames;
    this.duration = duration;
    this.latestTime = frames.length ? frames[frames.length - 1].time : 0;
    this.cursor = time;
    this.viewTarget = this.medianMidi() ?? this.viewTarget;
  }

  /** Empties the roll (e.g. after the shown recording was deleted). */
  clear(): void {
    this.live = false;
    this.frames = [];
    this.duration = 0;
    this.cursor = 0;
    this.latestTime = 0;
  }

  setTime(time: number): void {
    this.cursor = time;
  }

  /** The frame under the playhead in the last rendered picture. */
  currentFrame(): PitchFrame | null {
    return this.frameAt(this.renderedAt);
  }

  get scrubbable(): boolean {
    return !this.live && this.duration > 0;
  }

  render(nowMs: number): void {
    const dt = this.lastRenderAt ? Math.min(0.1, (nowMs - this.lastRenderAt) / 1000) : 0;
    this.lastRenderAt = nowMs;
    // Live: advance the clock smoothly between frame arrivals, but never run far ahead of the data.
    const now = this.live ? this.latestTime + Math.min(0.05, (nowMs - this.lastPushAt) / 1000) : this.cursor;
    this.renderedAt = now;

    const current = this.currentMidi(now);
    this.updateView(current, dt);
    this.updateLit(current, dt);

    const { ctx, width: w, height: h, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, w, h);
    if (w === 0 || h === 0) return;

    const layout = this.layout();
    this.drawLanes(layout);
    this.drawPlayhead(layout);
    this.drawLine(layout, now);
    this.drawKeyboard(layout);
  }

  // --- state ---------------------------------------------------------------------------------

  /** Index of the first frame at or after `time` (binary search; frames are time-ordered). */
  private indexAt(time: number): number {
    let lo = 0;
    let hi = this.frames.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.frames[mid].time < time) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** The frame sounding at `now`, or null. */
  private frameAt(now: number): PitchFrame | null {
    const i = this.indexAt(now + 1e-6) - 1;
    const f = i >= 0 ? this.frames[i] : undefined;
    return f && now - f.time <= 0.12 ? f : null;
  }

  /** MIDI of the frame sounding at `now` if it is voiced. */
  private currentMidi(now: number): number | null {
    return this.frameAt(now)?.midi ?? null;
  }

  /** Typical pitch of the loaded track, used to frame the view when a recording opens. */
  private medianMidi(): number | null {
    const voiced = this.frames.flatMap((f) => (f.midi === null ? [] : [f.midi])).sort((a, b) => a - b);
    return voiced.length ? voiced[voiced.length >> 1] : null;
  }

  private attachScrubbing(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (!this.scrubbable || !this.onScrub) return;
      this.drag = { pointerId: e.pointerId, startX: e.clientX, startTime: this.cursor };
      c.setPointerCapture(e.pointerId);
      c.classList.add('is-scrubbing');
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.drag || e.pointerId !== this.drag.pointerId) return;
      const { pxPerSec } = this.layout();
      const t = this.drag.startTime - (e.clientX - this.drag.startX) / pxPerSec;
      this.onScrub?.(Math.min(this.duration, Math.max(0, t)));
    });
    const end = (e: PointerEvent) => {
      if (!this.drag || e.pointerId !== this.drag.pointerId) return;
      this.drag = null;
      c.classList.remove('is-scrubbing');
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }

  private updateView(current: number | null, dt: number): void {
    const span = this.span();
    if (current !== null) {
      const margin = Math.min(4, span / 4);
      if (current > this.viewCenter + span / 2 - margin || current < this.viewCenter - span / 2 + margin) {
        this.viewTarget = current;
      }
    }
    const min = LOWEST_NOTE + span / 2;
    const max = HIGHEST_NOTE - span / 2;
    this.viewTarget = Math.min(max, Math.max(min, this.viewTarget));
    this.viewCenter += (this.viewTarget - this.viewCenter) * (1 - Math.exp(-dt * 4));
  }

  private updateLit(current: number | null, dt: number): void {
    const note = current === null ? null : Math.round(current);
    if (note !== null && !this.lit.has(note)) this.lit.set(note, 0);
    const k = 1 - Math.exp(-dt * 14);
    for (const [m, level] of this.lit) {
      const next = level + ((m === note ? 1 : 0) - level) * k;
      if (next < 0.01 && m !== note) this.lit.delete(m);
      else this.lit.set(m, next);
    }
  }

  // --- layout --------------------------------------------------------------------------------

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
  }

  /** Visible semitones, chosen so lanes stay a comfortable height. */
  private span(): number {
    return Math.min(36, Math.max(14, this.height / 20));
  }

  private layout() {
    const w = this.width;
    const h = this.height;
    const span = this.span();
    const laneH = h / span;
    const keyW = Math.min(104, Math.max(56, w * 0.14));
    const playheadX = keyW + (w - keyW) * this.playheadRatio;
    const pxPerSec = (playheadX - keyW) / this.secondsVisible;
    const center = this.viewCenter;
    return {
      w,
      h,
      laneH,
      keyW,
      playheadX,
      pxPerSec,
      lowNote: Math.floor(center - span / 2) - 1,
      highNote: Math.ceil(center + span / 2) + 1,
      yOf: (midi: number) => h / 2 - (midi - center) * laneH,
    };
  }

  // --- drawing -------------------------------------------------------------------------------

  private drawLanes(L: ReturnType<PianoRoll['layout']>): void {
    const { ctx } = this;
    for (let m = L.lowNote; m <= L.highNote; m++) {
      const top = L.yOf(m + 0.5);
      ctx.fillStyle = laneFill(m);
      ctx.fillRect(L.keyW, top, L.w - L.keyW, L.laneH);
      const level = this.lit.get(m);
      if (level) {
        ctx.fillStyle = litColor(m, 0.5 * level);
        ctx.fillRect(L.keyW, top, L.w - L.keyW, L.laneH);
      }
      ctx.fillStyle = theme.laneSeparator;
      ctx.fillRect(L.keyW, top, L.w - L.keyW, 1);
    }
  }

  private drawPlayhead(L: ReturnType<PianoRoll['layout']>): void {
    this.ctx.fillStyle = theme.playhead;
    this.ctx.fillRect(Math.round(L.playheadX), 0, 1, L.h);
  }

  private drawLine(L: ReturnType<PianoRoll['layout']>, now: number): void {
    const { ctx } = this;
    const xOf = (t: number) => L.playheadX - (now - t) * L.pxPerSec;

    ctx.save();
    ctx.beginPath();
    ctx.rect(L.keyW, 0, L.w - L.keyW, L.h);
    ctx.clip();

    // Older history fades out towards the keyboard.
    const fade = ctx.createLinearGradient(L.keyW, 0, L.keyW + (L.playheadX - L.keyW) * 0.45, 0);
    fade.addColorStop(0, 'rgba(255,255,255,0)');
    fade.addColorStop(1, theme.line);
    ctx.strokeStyle = fade;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowColor = theme.lineGlow;
    ctx.shadowBlur = 12;

    ctx.beginPath();
    let prev: PitchFrame | null = null;
    for (let i = this.indexAt(now - this.secondsVisible - 0.1); i < this.frames.length; i++) {
      const f = this.frames[i];
      if (f.time > now) break;
      if (f.midi === null) {
        prev = null;
        continue;
      }
      const x = xOf(f.time);
      const y = L.yOf(f.midi);
      const connected =
        prev !== null &&
        prev.midi !== null &&
        f.time - prev.time <= MAX_GAP_SECONDS &&
        Math.abs(f.midi - prev.midi) <= MAX_JUMP_SEMITONES;
      if (connected) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      prev = f;
    }
    ctx.stroke();

    // Glowing head dot on the playhead while the voice is sounding.
    const head = this.frameAt(now);
    if (head && head.midi !== null) {
      const x = xOf(head.time);
      const y = L.yOf(head.midi);
      ctx.fillStyle = theme.line;
      ctx.shadowBlur = 18;
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawKeyboard(L: ReturnType<PianoRoll['layout']>): void {
    const { ctx } = this;
    const radius = Math.min(4, L.laneH / 4);

    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, L.keyW, L.h);

    // White keys: extend halfway into neighbouring black-key rows, like a real keyboard.
    for (let m = L.lowNote; m <= L.highNote; m++) {
      if (isBlackKey(m)) continue;
      const top = isBlackKey(m + 1) ? L.yOf(m + 1) : L.yOf(m + 0.5);
      const bottom = isBlackKey(m - 1) ? L.yOf(m - 1) : L.yOf(m - 0.5);
      this.fillKey(m, 0, top + 1, L.keyW - 3, bottom - top - 2, radius, theme.whiteKey);

      if (pitchClass(m) === 0 && L.laneH >= 9) {
        ctx.fillStyle = this.lit.get(m) ? '#1a1a1a' : theme.keyLabel;
        ctx.font = `600 ${Math.min(11, L.laneH * 0.62)}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(`C${octaveOf(m)}`, L.keyW - 9, (top + bottom) / 2 + 1);
      }
    }

    // Black keys on top.
    const inset = L.laneH * 0.08;
    for (let m = L.lowNote; m <= L.highNote; m++) {
      if (!isBlackKey(m)) continue;
      const top = L.yOf(m + 0.5) + inset;
      this.fillKey(m, 0, top, L.keyW * 0.6, L.laneH - inset * 2, radius, theme.blackKey);
    }
  }

  private fillKey(midi: number, x: number, y: number, w: number, h: number, r: number, base: string): void {
    const { ctx } = this;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, [0, r, r, 0]);
    ctx.fillStyle = base;
    ctx.fill();
    const level = this.lit.get(midi);
    if (level) {
      ctx.fillStyle = litColor(midi, level);
      ctx.fill();
    }
  }
}
