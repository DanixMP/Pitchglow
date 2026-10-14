// Transport maths for the voice engine (pure, allocation-free, unit-tested): which song position each
// audio frame plays, split into runs at loop wraps, plus the short fades where a loop cuts a clip.
// Mirrors MixPlayer's scheduling of buffer sources, so engine lanes and instrumentals stay in sync.

/** All positions in samples at the context rate. */
export interface EngineTransport {
  /** Context frame at which song position `from` plays. */
  startFrame: number;
  from: number;
  loop: { start: number; end: number } | null;
}

/** Fade where a loop boundary cuts through a clip (as MixPlayer: 4 ms). */
export const LOOP_FADE_SECONDS = 0.004;

/** Song position (samples) heard at context frame `f`, or -1 before the transport starts. */
export function songSample(f: number, t: EngineTransport): number {
  const elapsed = f - t.startFrame;
  if (elapsed < 0) return -1;
  const p = t.from + elapsed;
  const loop = t.loop;
  if (!loop || t.from >= loop.end || p < loop.end) return p;
  return loop.start + ((p - loop.end) % (loop.end - loop.start));
}

/**
 * Splits a block of `n` frames starting at context frame `frame0` into runs of consecutive song
 * positions. Writes [blockIndex, songStart, length, wrapped (0/1)] per run into `runs` and returns
 * the number of runs. Frames before the start are skipped (silent).
 */
export function blockRuns(frame0: number, n: number, t: EngineTransport, runs: Float64Array): number {
  let count = 0;
  let i = 0;
  const loop = t.loop && t.from < t.loop.end ? t.loop : null;
  while (i < n && count * 4 < runs.length) {
    const p = songSample(frame0 + i, t);
    if (p < 0) {
      i += Math.min(n - i, t.startFrame - (frame0 + i));
      continue;
    }
    const len = loop ? Math.min(n - i, loop.end - p) : n - i;
    runs[count * 4] = i;
    runs[count * 4 + 1] = p;
    runs[count * 4 + 2] = len;
    runs[count * 4 + 3] = loop && frame0 + i - t.startFrame + t.from >= loop.end ? 1 : 0;
    count++;
    i += len;
  }
  return count;
}

/**
 * Gain at song position `p` for a clip spanning [clipStart, clipEnd) (song samples): fades out just
 * before the loop end if the clip goes on past it, and fades in after a wrap if the clip began
 * before the loop start. 1 elsewhere.
 */
export function loopFade(
  p: number,
  wrapped: boolean,
  loop: { start: number; end: number },
  clipStart: number,
  clipEnd: number,
  fade: number,
): number {
  let g = 1;
  if (clipEnd > loop.end && p > loop.end - fade) g = Math.min(g, Math.max(0, (loop.end - p) / fade));
  if (wrapped && clipStart < loop.start && p < loop.start + fade) g = Math.min(g, Math.max(0, (p - loop.start) / fade));
  return g;
}
