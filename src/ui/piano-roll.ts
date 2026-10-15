// Canvas piano roll: keyboard on the left, one coloured lane per semitone, and a glowing pitch line
// that scrolls left into a fixed "now" playhead (Goal.mp4, 0:00-0:20).
// With tuning on, the corrected line is drawn in the target note's colour over a faded original
// (0:04 "On auto-tune"), and lanes/keys outside the chosen scale are greyed out (1:12 "Only C major").

import type { PitchFrame } from '../audio/pitch-tracker';
import { PitchCorrector, correctTrack, type Correction, type TuneSettings } from '../dsp/autotune';
import { isBlackKey, octaveOf, pitchClass, pitchClassName } from '../dsp/notes';
import { harmonyNote } from '../dsp/harmony';
import { scaleMask, scaleName, type Scale } from '../dsp/scales';
import { applyNoteEdits, type NoteEdit } from '../dsp/note-edit';
import { gridLines, type Grid } from '../project/grid';
import { laneFill, litColor, theme } from './colors';

export interface PianoRollOptions {
  /** Seconds of history between the keyboard and the playhead. */
  secondsVisible?: number;
  /** Playhead position as a fraction of the lane area width. */
  playheadRatio?: number;
}

/**
 * A pitch frame plus its auto-tune correction (null fields when tuning is off or unvoiced) and the
 * notes the harmony voices sing at that moment (empty when there is no harmony).
 */
export type RollFrame = PitchFrame & Correction & { harmony: number[] };

const LOWEST_NOTE = 24; // C1
const HIGHEST_NOTE = 96; // C7
/** Frames further apart than this are drawn as separate strokes. */
const MAX_GAP_SECONDS = 0.04;
/** Jumps bigger than this between consecutive frames are treated as a break, not a glide. */
const MAX_JUMP_SEMITONES = 10;
const ALL_NOTES = new Array<boolean>(12).fill(true);
const FONT = 'ui-sans-serif, system-ui, sans-serif';

type Layout = ReturnType<PianoRoll['layout']>;

/** A sung note drawn as a blob in note-editing mode: its frames and where it now sits (roll time). */
export interface RollNote {
  from: number;
  to: number;
  start: number;
  end: number;
  edited: boolean;
}

/** A note drag in progress: cumulative pitch (semitones) and time (s) moved since it started. */
export interface NoteDrag {
  index: number;
  kind: 'move' | 'start' | 'end';
  semitones: number;
  seconds: number;
  /** Alt held: no snapping. */
  free: boolean;
  done: boolean;
}

/** Pixels at a blob's ends that resize it instead of moving it. */
const EDGE_PX = 7;

export class PianoRoll {
  private readonly ctx: CanvasRenderingContext2D;
  /** Offscreen layer for the lines, so the left-edge fade works for any line colour. */
  private readonly layer = document.createElement('canvas');
  private readonly layerCtx: CanvasRenderingContext2D;
  private readonly secondsVisible: number;
  private readonly playheadRatio: number;

  /** Live: frames stream in and old ones are dropped. Otherwise the picture follows `cursor`. */
  private frames: RollFrame[] = [];
  private latestTime = 0;
  private lastPushAt = 0;
  private live = false;
  private cursor = 0;
  private duration = 0;
  private renderedAt = 0;

  private tuning: TuneSettings | null = null;
  private ghosts: { frames: readonly PitchFrame[]; hue: number }[] = [];
  /** Tempo grid (bar and beat lines) and the song time of roll time 0. */
  private grid: Grid | null = null;
  private gridToSong = 0;
  /** The song's key: shown as the lanes when auto-tune is off (so you see the key while singing). */
  private scaleHint: Scale | null = null;
  private corrector: PitchCorrector | null = null;
  private mask = ALL_NOTES;

  private width = 0;
  private height = 0;
  private dpr = 1;

  private viewCenter = 52; // E3, middle of a typical speaking range
  private viewTarget = 52;
  private lit = new Map<number, number>();
  private lastRenderAt = 0;

  /** Note edits (Phase 18) shown on the line; note blobs while editing notes (null = not editing). */
  private edits: readonly NoteEdit[] = [];
  private notes: RollNote[] | null = null;
  private selectedNote: number | null = null;
  private noteDrag: { pointerId: number; index: number; kind: NoteDrag['kind']; x: number; y: number; axis: 'x' | 'y' | null } | null = null;

  /** Called with a new time while the user drags a recording left/right. */
  onScrub: ((time: number) => void) | null = null;
  /** Note editing: a note was clicked (null = empty space), or is being dragged. */
  onNoteSelect: ((index: number | null) => void) | null = null;
  onNoteDrag: ((drag: NoteDrag) => void) | null = null;
  private drag: { pointerId: number; startX: number; startTime: number } | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    opts: PianoRollOptions = {},
  ) {
    const ctx = canvas.getContext('2d');
    const layerCtx = this.layer.getContext('2d');
    if (!ctx || !layerCtx) throw new Error('Canvas 2D not supported');
    this.ctx = ctx;
    this.layerCtx = layerCtx;
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
    this.corrector?.reset();
  }

  /** Freezes the picture where it is. */
  stop(): void {
    this.live = false;
    this.cursor = this.latestTime;
  }

  push(frame: PitchFrame): void {
    const correction = this.correct(frame);
    this.frames.push({ ...frame, ...correction, harmony: this.harmonyFor(correction.target) });
    this.latestTime = frame.time;
    this.lastPushAt = performance.now();
    const keepFrom = frame.time - this.secondsVisible - 1;
    let drop = 0;
    while (drop < this.frames.length && this.frames[drop].time < keepFrom) drop++;
    if (drop > 0) this.frames.splice(0, drop);
  }

  /** Shows a whole recorded pitch track; move through it with `setTime`. */
  showRecording(frames: readonly PitchFrame[], duration: number, time = duration, keepView = false): void {
    this.live = false;
    this.frames = frames.map((f) => ({ ...f, target: null, corrected: null, harmony: [] }));
    this.retune();
    this.duration = duration;
    this.latestTime = frames.length ? frames[frames.length - 1].time : 0;
    this.cursor = time;
    if (!keepView) this.viewTarget = this.medianMidi() ?? this.viewTarget;
  }

  /**
   * Other tracks of the song, drawn as faint lines in their track colour behind the main line.
   * Frame times are song time (already shifted by each track's offset).
   */
  setGhosts(ghosts: readonly { frames: readonly PitchFrame[]; hue: number }[]): void {
    this.ghosts = ghosts.map((g) => ({ frames: g.frames, hue: g.hue }));
  }

  /**
   * Bar and beat lines of the song's tempo grid (null = none). `toSong` = song time at roll time 0
   * (0 when the roll shows song time; while recording over a song, where the live line started).
   */
  setGrid(grid: Grid | null, toSong = 0): void {
    this.grid = grid;
    this.gridToSong = toSong;
  }

  /** Note edits drawn on the line (the shown frames' indices). */
  setNoteEdits(edits: readonly NoteEdit[]): void {
    this.edits = edits;
    this.retune();
  }

  /** Note-editing mode: the blobs to draw and hit (null = off) and the selected one. */
  setNotes(notes: RollNote[] | null, selected: number | null): void {
    this.notes = notes;
    this.selectedNote = selected;
  }

  get editingNotes(): boolean {
    return this.notes !== null;
  }

  /** Empties the roll (e.g. after the shown recording was deleted). */
  clear(): void {
    this.live = false;
    this.frames = [];
    this.ghosts = [];
    this.duration = 0;
    this.cursor = 0;
    this.latestTime = 0;
  }

  /** Turns auto-tune display on (with these settings) or off (null). Re-corrects what is shown. */
  setTuning(settings: TuneSettings | null): void {
    this.tuning = settings;
    this.updateMask();
    this.corrector = settings ? new PitchCorrector(settings) : null;
    this.retune();
  }

  setScaleHint(scale: Scale | null): void {
    this.scaleHint = scale;
    this.updateMask();
  }

  private updateMask(): void {
    const scale = this.tuning?.scale ?? this.scaleHint;
    this.mask = scale ? scaleMask(scale) : ALL_NOTES;
  }

  setTime(time: number): void {
    this.cursor = time;
  }

  /** The frame under the playhead in the last rendered picture. */
  currentFrame(): RollFrame | null {
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

    const head = this.frameAt(now);
    this.updateView(head ? this.displayMidi(head) : null, dt);
    const leadNote = head ? this.litNote(head) : null;
    this.updateLit(leadNote === null ? [] : [leadNote, ...head!.harmony], dt);

    const { ctx, width: w, height: h, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, w, h);
    if (w === 0 || h === 0) return;

    const layout = this.layout();
    this.drawLanes(layout);
    if (this.grid) this.drawGrid(layout, now, this.grid);
    this.drawPlayhead(layout);
    if (this.notes) this.drawNotes(layout, now, this.notes);
    this.drawLines(layout, now);
    this.drawKeyboard(layout);
    if (this.tuning) this.drawTuningChip(layout, this.tuning);
  }

  // --- tuning --------------------------------------------------------------------------------

  private correct(frame: PitchFrame): Correction {
    return this.corrector?.process(frame) ?? { target: null, corrected: null };
  }

  private harmonyFor(target: number | null): number[] {
    const voices = this.tuning?.harmony?.voices;
    if (target === null || !voices?.length) return [];
    return voices.map((v) => harmonyNote(target, v, this.tuning!.scale));
  }

  private retune(): void {
    if (!this.tuning && !this.edits.length) {
      for (const f of this.frames) {
        f.target = f.corrected = null;
        f.harmony = [];
      }
      return;
    }
    const base = this.tuning ? correctTrack(this.frames, this.tuning) : this.frames.map((f) => ({ target: null, corrected: f.midi }));
    const corrections = applyNoteEdits(this.frames, base, this.edits);
    this.frames.forEach((f, i) => {
      Object.assign(f, corrections[i]);
      f.harmony = this.harmonyFor(f.target);
    });
    // Continue live correction from where the shown history ends.
    if (!this.tuning) return;
    this.corrector = new PitchCorrector(this.tuning);
    for (const f of this.frames.slice(-3)) this.corrector.process(f);
  }

  /** Whether the main line is a corrected curve (auto-tune or note edits) over the faded original. */
  private get corrected(): boolean {
    return this.tuning !== null || this.edits.length > 0;
  }

  /** The pitch drawn as the main line. */
  private displayMidi(f: RollFrame): number | null {
    return this.corrected ? (f.corrected ?? f.midi) : f.midi;
  }

  /** The note whose key and lane light up. */
  private litNote(f: RollFrame): number | null {
    if (this.tuning) return f.target;
    const m = this.displayMidi(f);
    return m === null ? null : Math.round(m);
  }

  // --- state ---------------------------------------------------------------------------------

  /** Index of the first frame at or after `time` (binary search; frames are time-ordered). */
  private indexAt(time: number, frames: readonly PitchFrame[] = this.frames): number {
    let lo = 0;
    let hi = frames.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (frames[mid].time < time) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** The frame sounding at `now`, or null. */
  private frameAt(now: number): RollFrame | null {
    const i = this.indexAt(now + 1e-6) - 1;
    const f = i >= 0 ? this.frames[i] : undefined;
    return f && now - f.time <= 0.12 ? f : null;
  }

  /** Typical pitch of the loaded track, used to frame the view when a recording opens. */
  private medianMidi(): number | null {
    const voiced = this.frames.flatMap((f) => (f.midi === null ? [] : [f.midi])).sort((a, b) => a - b);
    return voiced.length ? voiced[voiced.length >> 1] : null;
  }

  /** The note lane under a point (client coordinates), and whether it is over the keyboard. */
  noteAt(clientX: number, clientY: number): { midi: number; onKeys: boolean } | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
    const L = this.layout();
    const midi = Math.round(this.viewCenter + (L.h / 2 - y) / L.laneH);
    return { midi, onKeys: x < L.keyW };
  }

  private attachScrubbing(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (this.notes) {
        const hit = this.noteHit(e.clientX, e.clientY);
        this.onNoteSelect?.(hit ? hit.index : null);
        if (hit) {
          this.noteDrag = { pointerId: e.pointerId, index: hit.index, kind: hit.kind, x: e.clientX, y: e.clientY, axis: hit.kind === 'move' ? null : 'x' };
          c.setPointerCapture(e.pointerId);
          c.classList.add('is-note-dragging');
          return;
        }
      }
      if (!this.scrubbable || !this.onScrub) return;
      this.drag = { pointerId: e.pointerId, startX: e.clientX, startTime: this.cursor };
      c.setPointerCapture(e.pointerId);
      c.classList.add('is-scrubbing');
    });
    c.addEventListener('pointermove', (e) => {
      const nd = this.noteDrag;
      if (nd && e.pointerId === nd.pointerId) return this.dragNote(nd, e, false);
      if (this.notes && !nd) {
        const hit = this.noteHit(e.clientX, e.clientY);
        c.classList.toggle('is-note-hover', hit?.kind === 'move');
        c.classList.toggle('is-note-edge', !!hit && hit.kind !== 'move');
      }
      if (!this.drag || e.pointerId !== this.drag.pointerId) return;
      const { pxPerSec } = this.layout();
      const t = this.drag.startTime - (e.clientX - this.drag.startX) / pxPerSec;
      this.onScrub?.(Math.min(this.duration, Math.max(0, t)));
    });
    const end = (e: PointerEvent) => {
      const nd = this.noteDrag;
      if (nd && e.pointerId === nd.pointerId) {
        this.noteDrag = null;
        c.classList.remove('is-note-dragging');
        return this.dragNote(nd, e, true);
      }
      if (!this.drag || e.pointerId !== this.drag.pointerId) return;
      this.drag = null;
      c.classList.remove('is-scrubbing');
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }

  /** Cumulative note drag. Moves lock to one axis (pitch or time) once they pass a few pixels. */
  private dragNote(nd: NonNullable<PianoRoll['noteDrag']>, e: PointerEvent, done: boolean): void {
    const { pxPerSec, laneH } = this.layout();
    const dx = e.clientX - nd.x;
    const dy = e.clientY - nd.y;
    if (nd.axis === null && Math.hypot(dx, dy) > 5) nd.axis = Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
    if (nd.axis === null && !done) return;
    this.onNoteDrag?.({
      index: nd.index,
      kind: nd.kind,
      semitones: nd.axis === 'y' ? -dy / laneH : 0,
      seconds: nd.axis === 'x' ? dx / pxPerSec : 0,
      free: e.altKey,
      done,
    });
  }

  /** The note blob under a point (client coordinates), and whether an end of it was grabbed. */
  private noteHit(clientX: number, clientY: number): { index: number; kind: NoteDrag['kind'] } | null {
    const notes = this.notes;
    if (!notes) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const L = this.layout();
    if (x < L.keyW) return null;
    const xOf = (t: number) => L.playheadX - (this.renderedAt - t) * L.pxPerSec;
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      const pitch = this.notePitch(n);
      if (pitch === null) continue;
      const x0 = xOf(n.start);
      const x1 = xOf(n.end);
      if (x < x0 - 2 || x > x1 + 2 || Math.abs(y - L.yOf(pitch)) > L.laneH * 0.6) continue;
      const edges = x1 - x0 > EDGE_PX * 3;
      if (edges && x - x0 < EDGE_PX) return { index: i, kind: 'start' };
      if (edges && x1 - x < EDGE_PX) return { index: i, kind: 'end' };
      return { index: i, kind: 'move' };
    }
    return null;
  }

  /** Where a note blob sits: the median of the line over its frames. */
  private notePitch(n: RollNote): number | null {
    const values: number[] = [];
    for (let i = n.from; i < Math.min(n.to, this.frames.length); i++) {
      const m = this.displayMidi(this.frames[i]);
      if (m !== null) values.push(m);
    }
    values.sort((a, b) => a - b);
    return values.length ? values[values.length >> 1] : null;
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

  /** Fades lit keys/lanes towards the currently sounding notes (lead + harmony voices). */
  private updateLit(notes: readonly number[], dt: number): void {
    for (const n of notes) if (!this.lit.has(n)) this.lit.set(n, 0);
    const k = 1 - Math.exp(-dt * 14);
    for (const [m, level] of this.lit) {
      const on = notes.includes(m);
      const next = level + ((on ? 1 : 0) - level) * k;
      if (next < 0.01 && !on) this.lit.delete(m);
      else this.lit.set(m, next);
    }
  }

  // --- layout --------------------------------------------------------------------------------

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = this.layer.width = Math.round(rect.width * this.dpr);
    this.canvas.height = this.layer.height = Math.round(rect.height * this.dpr);
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

  private inScale(midi: number): boolean {
    return this.mask[pitchClass(midi)];
  }

  // --- drawing -------------------------------------------------------------------------------

  private drawLanes(L: Layout): void {
    const { ctx } = this;
    for (let m = L.lowNote; m <= L.highNote; m++) {
      const top = L.yOf(m + 0.5);
      ctx.fillStyle = this.inScale(m) ? laneFill(m) : theme.offScaleLane;
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

  /** Beat lines (faint) and bar lines with their numbers, scrolling with the line. */
  private drawGrid(L: Layout, now: number, grid: Grid): void {
    const { ctx } = this;
    const toSong = this.gridToSong;
    const start = now - (L.playheadX - L.keyW) / L.pxPerSec + toSong;
    const end = now + (L.w - L.playheadX) / L.pxPerSec + toSong;
    ctx.font = '600 9px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'top';
    for (const line of gridLines(start, end, grid, 12 / L.pxPerSec)) {
      const x = Math.round(L.playheadX + (line.time - toSong - now) * L.pxPerSec);
      if (x <= L.keyW) continue;
      ctx.fillStyle = line.bar !== null ? theme.gridBar : theme.gridBeat;
      ctx.fillRect(x, 0, 1, L.h);
      if (line.bar !== null && line.bar >= 1) {
        ctx.fillStyle = theme.gridLabel;
        ctx.fillText(String(line.bar), x + 4, 6);
      }
    }
  }

  private drawPlayhead(L: Layout): void {
    this.ctx.fillStyle = theme.playhead;
    this.ctx.fillRect(Math.round(L.playheadX), 0, 1, L.h);
  }

  private drawLines(L: Layout, now: number): void {
    const { layerCtx: g, dpr } = this;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.layer.width, this.layer.height);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.save();
    g.beginPath();
    g.rect(L.keyW, 0, L.w - L.keyW, L.h);
    g.clip();
    g.lineJoin = 'round';
    g.lineCap = 'round';

    const xOf = (t: number) => L.playheadX - (now - t) * L.pxPerSec;
    const from = this.indexAt(now - this.secondsVisible - 0.1);
    // Editing notes: the whole window, ahead of the playhead too (you edit what comes next).
    const ahead = this.notes ? (L.w - L.playheadX) / L.pxPerSec + 0.1 : 1e-6;
    const to = this.indexAt(now + ahead);

    // Other tracks of the song: faint lines in their track colours.
    for (const ghost of this.ghosts) {
      g.strokeStyle = `hsl(${ghost.hue} 70% 70% / 0.32)`;
      g.lineWidth = 1.5;
      g.beginPath();
      let prev: PitchFrame | null = null;
      const end = this.indexAt(now + ahead, ghost.frames);
      for (let i = this.indexAt(now - this.secondsVisible - 0.1, ghost.frames); i < end; i++) {
        const f = ghost.frames[i];
        if (f.midi === null) {
          prev = null;
          continue;
        }
        const joined = prev?.midi != null && f.time - prev.time <= MAX_GAP_SECONDS && Math.abs(f.midi - prev.midi) <= MAX_JUMP_SEMITONES;
        if (joined) g.lineTo(xOf(f.time), L.yOf(f.midi));
        else g.moveTo(xOf(f.time), L.yOf(f.midi));
        prev = f;
      }
      g.stroke();
    }

    if (this.corrected) {
      // What was actually sung, faded underneath the corrected line.
      g.strokeStyle = theme.originalLine;
      g.lineWidth = 1.75;
      g.beginPath();
      this.tracePath(g, L, xOf, from, to, (f) => f.midi);
      g.stroke();
    }

    // Harmony voices: thinner lines on their own notes' lanes (Goal.mp4, 1:28).
    const voiceCount = this.tuning?.harmony?.voices.length ?? 0;
    for (let k = 0; k < voiceCount; k++) {
      const note = (f: RollFrame) => f.harmony[k] ?? null;
      const value = (f: RollFrame) => (f.corrected === null || f.target === null || f.harmony[k] === undefined ? null : f.corrected + f.harmony[k] - f.target);
      this.strokeRuns(g, L, xOf, from, to, value, note, 1.75, 8, 0.85);
    }

    // Main line: white, or the target note's colour when tuned.
    this.strokeRuns(g, L, xOf, from, to, (f) => this.displayMidi(f), (f) => (this.tuning ? f.target : null), 2.5, 12, 1);

    // Glowing head dot on the playhead while the voice is sounding.
    const head = this.frameAt(now);
    const headY = head ? this.displayMidi(head) : null;
    if (head && headY !== null) {
      const color = this.tuning && head.target !== null ? litColor(head.target) : theme.line;
      g.fillStyle = color;
      g.shadowColor = this.tuning ? color : theme.lineGlow;
      g.shadowBlur = 18;
      g.beginPath();
      g.arc(xOf(head.time), L.yOf(headY), 4.5, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();

    // Older history fades out towards the keyboard (not while editing notes: all of it matters).
    if (!this.notes) this.fadeHistory(g, L);

    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.drawImage(this.layer, 0, 0);
    this.ctx.restore();
  }

  /** Note blobs: rounded bars on the notes' lanes, the selected one outlined. */
  private drawNotes(L: Layout, now: number, notes: RollNote[]): void {
    const { ctx } = this;
    const xOf = (t: number) => L.playheadX - (now - t) * L.pxPerSec;
    ctx.save();
    ctx.beginPath();
    ctx.rect(L.keyW, 0, L.w - L.keyW, L.h);
    ctx.clip();
    notes.forEach((n, i) => {
      const x0 = xOf(n.start);
      const x1 = xOf(n.end);
      if (x1 < L.keyW || x0 > L.w) return;
      const pitch = this.notePitch(n);
      if (pitch === null) return;
      const lane = Math.round(pitch);
      const y = L.yOf(pitch);
      const h = Math.max(8, L.laneH * 0.82);
      const selected = i === this.selectedNote;
      ctx.beginPath();
      ctx.roundRect(x0, y - h / 2, Math.max(4, x1 - x0), h, Math.min(h / 2, 8));
      ctx.fillStyle = litColor(lane, selected ? 0.42 : n.edited ? 0.3 : 0.2);
      ctx.fill();
      ctx.lineWidth = selected ? 2 : 1;
      ctx.strokeStyle = selected ? '#ffffff' : litColor(lane, n.edited ? 0.9 : 0.55);
      if (selected) {
        ctx.shadowColor = litColor(lane);
        ctx.shadowBlur = 12;
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    });
    ctx.restore();
  }

  private fadeHistory(g: CanvasRenderingContext2D, L: Layout): void {
    g.save();
    g.globalCompositeOperation = 'destination-out';
    const fade = g.createLinearGradient(L.keyW, 0, L.keyW + (L.playheadX - L.keyW) * 0.45, 0);
    fade.addColorStop(0, 'rgba(0,0,0,1)');
    fade.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = fade;
    g.fillRect(L.keyW, 0, (L.playheadX - L.keyW) * 0.45, L.h);
    g.restore();
  }

  /**
   * Strokes a line through `value(f)` for frames [from, to), one stroke per run of the same colour
   * (the lit colour of `note(f)`, or white when null), keeping colour changes visually continuous.
   */
  private strokeRuns(
    g: CanvasRenderingContext2D,
    L: Layout,
    xOf: (t: number) => number,
    from: number,
    to: number,
    value: (f: RollFrame) => number | null,
    note: (f: RollFrame) => number | null,
    width: number,
    blur: number,
    alpha: number,
  ): void {
    g.save();
    g.lineWidth = width;
    g.shadowBlur = blur;
    g.globalAlpha = alpha;
    let prev: RollFrame | null = null;
    let prevY = 0;
    let runColor = '';
    for (let i = from; i < to; i++) {
      const f = this.frames[i];
      const y = value(f);
      if (y === null) {
        prev = null;
        continue;
      }
      const n = note(f);
      const color = n === null ? theme.line : litColor(n);
      const connected = prev !== null && this.connected(prev, f, prevY, y);
      if (color !== runColor) {
        if (runColor) g.stroke();
        runColor = color;
        g.strokeStyle = color;
        g.shadowColor = n === null ? theme.lineGlow : color;
        g.beginPath();
        // Start the new colour where the previous one ended so the line stays continuous.
        if (connected) g.moveTo(xOf(prev!.time), L.yOf(prevY));
        else g.moveTo(xOf(f.time), L.yOf(y));
      }
      if (connected) g.lineTo(xOf(f.time), L.yOf(y));
      else g.moveTo(xOf(f.time), L.yOf(y));
      prev = f;
      prevY = y;
    }
    if (runColor) g.stroke();
    g.restore();
  }

  private connected(a: RollFrame, b: RollFrame, ya: number, yb: number): boolean {
    return b.time - a.time <= MAX_GAP_SECONDS && Math.abs(yb - ya) <= MAX_JUMP_SEMITONES;
  }

  /** Adds one polyline per voiced run of frames to the current path. */
  private tracePath(
    g: CanvasRenderingContext2D,
    L: Layout,
    xOf: (t: number) => number,
    from: number,
    to: number,
    value: (f: RollFrame) => number | null,
  ): void {
    let prev: RollFrame | null = null;
    for (let i = from; i < to; i++) {
      const f = this.frames[i];
      const y = value(f);
      if (y === null) {
        prev = null;
        continue;
      }
      if (prev && this.connected(prev, f, value(prev)!, y)) g.lineTo(xOf(f.time), L.yOf(y));
      else g.moveTo(xOf(f.time), L.yOf(y));
      prev = f;
    }
  }

  private drawKeyboard(L: Layout): void {
    const { ctx } = this;
    const radius = Math.min(4, L.laneH / 4);
    const shownScale = this.tuning?.scale ?? this.scaleHint;
    const labelAll = !!shownScale && shownScale.type !== 'chromatic';
    const fontSize = Math.min(11, L.laneH * 0.62);
    const showLabels = L.laneH >= 9;

    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, L.keyW, L.h);
    ctx.font = `600 ${fontSize}px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    // White keys: extend halfway into neighbouring black-key rows, like a real keyboard.
    for (let m = L.lowNote; m <= L.highNote; m++) {
      if (isBlackKey(m)) continue;
      const top = isBlackKey(m + 1) ? L.yOf(m + 1) : L.yOf(m + 0.5);
      const bottom = isBlackKey(m - 1) ? L.yOf(m - 1) : L.yOf(m - 0.5);
      const allowed = this.inScale(m);
      this.fillKey(m, 0, top + 1, L.keyW - 3, bottom - top - 2, radius, allowed ? theme.whiteKey : theme.offScaleWhiteKey);

      const isC = pitchClass(m) === 0;
      if (showLabels && (isC || (labelAll && allowed))) {
        ctx.fillStyle = this.lit.get(m) ? '#1a1a1a' : allowed ? theme.keyLabel : theme.offScaleLabel;
        ctx.fillText(isC ? `C${octaveOf(m)}` : pitchClassName(m), L.keyW - 9, L.yOf(m) + 1);
      }
    }

    // Black keys on top.
    const inset = L.laneH * 0.08;
    for (let m = L.lowNote; m <= L.highNote; m++) {
      if (!isBlackKey(m)) continue;
      const top = L.yOf(m + 0.5) + inset;
      const allowed = this.inScale(m);
      this.fillKey(m, 0, top, L.keyW * 0.6, L.laneH - inset * 2, radius, allowed ? theme.blackKey : theme.offScaleBlackKey);
      if (showLabels && labelAll && allowed) {
        ctx.fillStyle = this.lit.get(m) ? '#1a1a1a' : '#d8d8dc';
        ctx.fillText(pitchClassName(m), L.keyW * 0.6 - 5, L.yOf(m) + 1);
      }
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

  /** "SCALE C MAJOR · RETUNE 66 ms" chip in the top-left of the lanes (Goal.mp4, 0:58 / 1:08). */
  private drawTuningChip(L: Layout, t: TuneSettings): void {
    const { ctx } = this;
    const parts: [string, string][] = [
      ['SCALE', scaleName(t.scale).toUpperCase()],
      ['RETUNE', `${Math.round(t.retuneMs)} ms`],
    ];
    const voices = t.harmony?.voices.length ?? 0;
    if (voices) parts.push(['HARMONY', `+${voices}`]);
    const labelFont = `600 9px ${FONT}`;
    const valueFont = `700 11px ${FONT}`;
    const pad = 9;
    const gap = 6;
    const sep = 14;

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    let width = pad * 2;
    const measured = parts.map(([label, value]) => {
      ctx.font = labelFont;
      const lw = ctx.measureText(label).width + label.length * 1.2;
      ctx.font = valueFont;
      const vw = ctx.measureText(value).width;
      return { label, value, lw, vw };
    });
    measured.forEach((p, i) => (width += p.lw + gap + p.vw + (i ? sep : 0)));

    const x = L.keyW + 10;
    const y = 10;
    const h = 24;
    if (x + width > L.w - 10) return; // too narrow; the controls below show the same info
    ctx.beginPath();
    ctx.roundRect(x, y, width, h, 7);
    ctx.fillStyle = 'rgba(12, 12, 14, 0.82)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();

    let cx = x + pad;
    measured.forEach((p, i) => {
      if (i) cx += sep;
      ctx.font = labelFont;
      ctx.fillStyle = theme.keyLabel;
      ctx.letterSpacing = '1.2px';
      ctx.fillText(p.label, cx, y + h / 2 + 0.5);
      ctx.letterSpacing = '0px';
      cx += p.lw + gap;
      ctx.font = valueFont;
      ctx.fillStyle = i === 0 ? theme.chipValue : theme.chipAccent;
      ctx.fillText(p.value, cx, y + h / 2 + 0.5);
      cx += p.vw;
    });
  }
}
