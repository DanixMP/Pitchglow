// Timeline under the piano roll: one lane per track with its clip (waveform) at its song position.
// Drag a clip to move it (snaps to 1/16 notes with a tempo, 10 ms without; Alt = free), click empty
// space to seek. The drag is previewed locally and committed once on release (one undo step).
// Keyboard: with the canvas focused, ←/→ nudge the selected clip by one grid step (Shift: ×4).

import { PEAKS_PER_SECOND } from '../audio/peaks';
import { snapOffset } from '../project/model';
import { formatTime } from './format';

export interface TimelineClip {
  id: string;
  /** CSS colour of the clip. */
  color: string;
  peaks: Float32Array;
  offset: number;
  duration: number;
  muted: boolean;
  selected: boolean;
}

export interface TimelineHandlers {
  onSeek(time: number): void;
  onMove(id: string, offset: number): void;
  onSelect(id: string): void;
}

const AXIS_H = 14;
const LANE_H = 16;
const LANE_GAP = 4;

export class Timeline {
  private readonly ctx: CanvasRenderingContext2D;
  private clips: TimelineClip[] = [];
  private bpm: number | null = null;
  private songDuration = 0;
  private time = 0;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private dirty = true;
  private drag: { pointerId: number; id: string; startX: number; startOffset: number; moved: boolean; preview: number } | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly handlers: TimelineHandlers,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D not supported');
    this.ctx = ctx;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.attach();
  }

  setClips(clips: TimelineClip[], songDuration: number, bpm: number | null): void {
    this.clips = clips;
    this.songDuration = songDuration;
    this.bpm = bpm;
    const h = AXIS_H + Math.max(1, clips.length) * (LANE_H + LANE_GAP);
    this.canvas.style.height = `${h}px`;
    this.dirty = true;
  }

  setTime(time: number): void {
    if (Math.abs(time - this.time) > 1e-3) {
      this.time = time;
      this.dirty = true;
    }
  }

  render(): void {
    if (!this.dirty || this.width === 0) return;
    this.dirty = false;
    const { ctx, width: w, height: h, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const view = this.view();
    const x = (t: number) => ((t - view.start) / (view.end - view.start)) * w;

    // Bars (with a tempo) or seconds grid + labels.
    ctx.font = `600 9px ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    const span = view.end - view.start;
    const step = this.bpm ? (60 / this.bpm) * 4 * Math.max(1, Math.ceil(span / 24 / ((60 / this.bpm) * 4))) : niceStep(span);
    for (let t = Math.ceil(view.start / step) * step; t <= view.end; t += step) {
      const gx = Math.round(x(t)) + 0.5;
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(gx, AXIS_H, 1, h - AXIS_H);
      ctx.fillStyle = '#6a6a70';
      const label = this.bpm ? `${Math.round(t / ((60 / this.bpm) * 4)) + 1}` : formatTime(t);
      ctx.fillText(label, gx + 3, 2);
    }
    // Song start marker (clips can start before it, e.g. a count-in).
    if (view.start < 0) {
      ctx.fillStyle = 'rgba(246,196,83,0.35)';
      ctx.fillRect(Math.round(x(0)), AXIS_H, 1, h - AXIS_H);
    }

    // Clips.
    this.clips.forEach((clip, i) => {
      const y = AXIS_H + i * (LANE_H + LANE_GAP);
      const offset = this.drag?.id === clip.id ? this.drag.preview : clip.offset;
      const x0 = x(offset);
      const x1 = x(offset + clip.duration);
      ctx.globalAlpha = clip.muted ? 0.35 : 1;
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.beginPath();
      ctx.roundRect(x0, y, Math.max(2, x1 - x0), LANE_H, 4);
      ctx.fill();
      // Waveform: peak per pixel column, mirrored around the lane centre.
      ctx.fillStyle = clip.color;
      const mid = y + LANE_H / 2;
      const pxPerSec = w / span;
      for (let px = Math.max(0, Math.floor(x0)); px < Math.min(w, Math.ceil(x1)); px++) {
        const a = Math.floor(((px - x0) / pxPerSec) * PEAKS_PER_SECOND);
        const b = Math.max(a + 1, Math.floor(((px + 1 - x0) / pxPerSec) * PEAKS_PER_SECOND));
        let peak = 0;
        for (let k = Math.max(0, a); k < Math.min(clip.peaks.length, b); k++) peak = Math.max(peak, clip.peaks[k]);
        const hh = Math.max(0.5, Math.min(1, Math.sqrt(peak)) * (LANE_H / 2 - 1));
        ctx.fillRect(px, mid - hh, 1, hh * 2);
      }
      if (clip.selected) {
        ctx.strokeStyle = 'rgba(246,196,83,0.85)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect(x0 + 0.75, y + 0.75, Math.max(2, x1 - x0 - 1.5), LANE_H - 1.5, 4);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    });

    // Playhead.
    ctx.fillStyle = '#f4f2ee';
    ctx.fillRect(Math.round(x(this.time)), 0, 1.5, h);
  }

  /** Visible song-time range: the song plus any clip hanging out before 0 or past the end. */
  private view(): { start: number; end: number } {
    let start = 0;
    let end = Math.max(1, this.songDuration);
    for (const c of this.clips) {
      start = Math.min(start, c.offset);
      end = Math.max(end, c.offset + c.duration);
    }
    const pad = (end - start) * 0.02;
    return { start: start - (start < 0 ? pad : 0), end: end + pad };
  }

  private timeAt(clientX: number): number {
    const rect = this.canvas.getBoundingClientRect();
    const v = this.view();
    return v.start + ((clientX - rect.left) / rect.width) * (v.end - v.start);
  }

  private clipAt(clientX: number, clientY: number): TimelineClip | null {
    const rect = this.canvas.getBoundingClientRect();
    const lane = Math.floor((clientY - rect.top - AXIS_H) / (LANE_H + LANE_GAP));
    const clip = this.clips[lane];
    if (!clip) return null;
    const t = this.timeAt(clientX);
    return t >= clip.offset && t <= clip.offset + clip.duration ? clip : null;
  }

  private attach(): void {
    const c = this.canvas;
    c.tabIndex = 0;
    c.addEventListener('pointerdown', (e) => {
      const clip = this.clipAt(e.clientX, e.clientY);
      if (clip) this.handlers.onSelect(clip.id);
      this.drag = clip
        ? { pointerId: e.pointerId, id: clip.id, startX: e.clientX, startOffset: clip.offset, moved: false, preview: clip.offset }
        : null;
      if (!clip) this.handlers.onSeek(Math.max(0, this.timeAt(e.clientX)));
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.pointerId) {
        c.style.cursor = this.clipAt(e.clientX, e.clientY) ? 'grab' : 'pointer';
        return;
      }
      const rect = c.getBoundingClientRect();
      const v = this.view();
      const dt = ((e.clientX - d.startX) / rect.width) * (v.end - v.start);
      if (Math.abs(e.clientX - d.startX) > 3) d.moved = true;
      d.preview = snapOffset(d.startOffset + dt, this.bpm, e.altKey);
      c.style.cursor = 'grabbing';
      this.dirty = true;
    });
    const end = (e: PointerEvent) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.pointerId) return;
      this.drag = null;
      if (d.moved && d.preview !== d.startOffset) this.handlers.onMove(d.id, d.preview);
      this.dirty = true;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const clip = this.clips.find((x) => x.selected);
      if (!clip) return;
      e.preventDefault();
      const grid = this.bpm ? 60 / this.bpm / 4 : 0.01;
      const delta = (e.key === 'ArrowLeft' ? -1 : 1) * grid * (e.shiftKey ? 4 : 1);
      this.handlers.onMove(clip.id, snapOffset(clip.offset + delta, this.bpm));
    });
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    this.dirty = true;
  }
}

/** 1, 2, 5, 10, 15, 30, 60 s… so there are ~8–16 grid lines. */
function niceStep(span: number): number {
  for (const s of [1, 2, 5, 10, 15, 30, 60, 120]) if (span / s <= 16) return s;
  return 300;
}
