// AudioWorklet processor: the beat with the song's key shift applied live (Phase 15). It holds the
// decoded instrumental and renders whatever song position each audio frame plays with the streaming
// phase vocoder (ShiftStream), following the same transport messages as the voice engine (loops,
// seeks). A seek, loop wrap or new shift restarts the vocoder there, after a short warm-up.

import { ShiftStream } from '../../dsp/shift-stream';
import { BEAT_PROCESSOR, type BeatMessage, type BeatOptions } from './protocol';
import { blockRuns, LOOP_FADE_SECONDS, loopFade, type EngineTransport } from './transport';

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
declare function registerProcessor(name: string, ctor: new (options: { processorOptions?: unknown }) => AudioWorkletProcessor): void;
declare const currentFrame: number;
declare const sampleRate: number;

class BeatEngineProcessor extends AudioWorkletProcessor {
  private readonly channels: Float32Array[];
  private readonly stream: ShiftStream;
  private semitones: number;
  private restart = true;
  private offset: number;
  private transport: EngineTransport | null;
  private readonly runs = new Float64Array(16);
  private readonly fade = Math.max(1, Math.round(LOOP_FADE_SECONDS * sampleRate));
  private readonly outs: Float32Array[] = [];

  constructor(options: { processorOptions?: unknown }) {
    super(options);
    const o = options.processorOptions as BeatOptions;
    this.channels = o.channels;
    this.stream = new ShiftStream(o.channels);
    this.semitones = o.semitones;
    this.stream.setSemitones(o.semitones);
    this.offset = o.offset;
    this.transport = o.transport;
    this.port.onmessage = (e: MessageEvent<BeatMessage>) => {
      const m = e.data;
      if (m.type === 'shift') {
        this.semitones = m.semitones;
        this.stream.setSemitones(m.semitones);
        this.restart = true;
      } else if (m.type === 'offset') this.offset = m.offset;
      else if (m.type === 'play') this.transport = m.transport;
      else if (m.type === 'stop') this.transport = null;
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (!out?.length) return true;
    for (const ch of out) ch.fill(0);
    const t = this.transport;
    if (!t) return true;
    const n = out[0].length;
    const length = this.channels[0].length;
    const count = blockRuns(currentFrame, n, t, this.runs);
    for (let r = 0; r < count; r++) {
      const i = this.runs[r * 4];
      const p = this.runs[r * 4 + 1];
      const len = this.runs[r * 4 + 2];
      // The part of this run that falls inside the beat.
      const from = Math.max(0, p - this.offset);
      const to = Math.min(length, p - this.offset + len);
      if (from >= to) continue;
      const at = i + (from - (p - this.offset));
      const span = to - from;
      if (this.semitones === 0) {
        for (let c = 0; c < out.length; c++) out[c].set(this.channels[Math.min(c, this.channels.length - 1)].subarray(from, to), at);
      } else {
        if (this.restart || this.stream.next !== from) {
          this.stream.startAt(from);
          this.restart = false;
        }
        this.outs.length = 0;
        for (const ch of out) this.outs.push(ch);
        this.stream.render(span, this.outs, at);
      }
      const loop = t.loop;
      if (!loop) continue;
      const wrapped = this.runs[r * 4 + 3] === 1;
      const songAt = p + (at - i);
      if (songAt + span > loop.end - this.fade || (wrapped && songAt < loop.start + this.fade)) {
        for (let k = 0; k < span; k++) {
          const g = loopFade(songAt + k, wrapped, loop, this.offset, this.offset + length, this.fade);
          for (const ch of out) ch[at + k] *= g;
        }
      }
    }
    return true;
  }
}

registerProcessor(BEAT_PROCESSOR, BeatEngineProcessor);
