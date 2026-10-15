// AudioWorklet processor: the metronome (Phase 17). Clicks on the beats of whatever song position
// each audio frame plays (ClickTrack), following the same transport messages as the voice engine,
// so it stays on the beat through seeks and loop wraps. Also plays the count-in before a take.

import { ClickTrack } from '../../dsp/click';
import { CLICK_PROCESSOR, type ClickMessage, type ClickOptions } from './protocol';
import { blockRuns, type EngineTransport } from './transport';

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
declare function registerProcessor(name: string, ctor: new (options: { processorOptions?: unknown }) => AudioWorkletProcessor): void;
declare const currentFrame: number;
declare const sampleRate: number;

class ClickEngineProcessor extends AudioWorkletProcessor {
  private readonly clicks: ClickTrack;
  private transport: EngineTransport | null = null;
  private bias = 0;
  private before = Infinity;
  private readonly runs = new Float64Array(16);

  constructor(options: { processorOptions?: unknown }) {
    super(options);
    const o = options.processorOptions as ClickOptions;
    this.clicks = new ClickTrack(sampleRate, o.grid);
    this.port.onmessage = (e: MessageEvent<ClickMessage>) => {
      const m = e.data;
      if (m.type === 'grid') this.clicks.setGrid(m.grid);
      else if (m.type === 'play') {
        this.transport = m.transport;
        this.bias = m.bias;
        this.before = m.before ?? Infinity;
      } else if (m.type === 'stop') {
        this.transport = null;
        this.clicks.reset();
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (!out?.length) return true;
    const ch = out[0];
    ch.fill(0);
    const t = this.transport;
    if (t) {
      const count = blockRuns(currentFrame, ch.length, t, this.runs);
      for (let r = 0; r < count; r++) {
        this.clicks.render(ch, this.runs[r * 4], this.runs[r * 4 + 1] - this.bias, this.runs[r * 4 + 2], this.before);
      }
    }
    for (let c = 1; c < out.length; c++) out[c].set(ch);
    return true;
  }
}

registerProcessor(CLICK_PROCESSOR, ClickEngineProcessor);
