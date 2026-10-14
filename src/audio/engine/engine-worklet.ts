// AudioWorklet processor: the voice engine for one vocal track (Phase 13). It holds the take's source
// audio and grain plans, follows the transport messages from MixPlayer, and renders whatever song
// position each audio frame plays (loops included). Settings changes arrive as new plans and apply
// from the next 128-sample block. Nothing is allocated while rendering.

import { ENGINE_BLOCK, VoiceRenderer } from '../../dsp/voice-engine';
import { ENGINE_PROCESSOR, type EngineMessage, type EngineOptions } from './protocol';
import { blockRuns, LOOP_FADE_SECONDS, loopFade, type EngineTransport } from './transport';

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
declare function registerProcessor(name: string, ctor: new (options: { processorOptions?: unknown }) => AudioWorkletProcessor): void;
declare const currentFrame: number;
declare const sampleRate: number;

class VoiceEngineProcessor extends AudioWorkletProcessor {
  private readonly renderer = new VoiceRenderer();
  private transport: EngineTransport | null = null;
  private offset = 0;
  private readonly runs = new Float64Array(16);
  private readonly fade = Math.max(1, Math.round(LOOP_FADE_SECONDS * sampleRate));

  constructor(options: { processorOptions?: unknown }) {
    super(options);
    const o = options.processorOptions as EngineOptions | undefined;
    if (o) {
      this.renderer.setSource(o.samples);
      this.renderer.setPlans(o.plans);
      this.offset = o.offset;
      this.transport = o.transport;
    }
    this.port.onmessage = (e: MessageEvent<EngineMessage>) => this.handle(e.data);
  }

  private handle(m: EngineMessage): void {
    switch (m.type) {
      case 'source':
        this.renderer.setSource(m.samples);
        this.renderer.setPlans(m.plans);
        break;
      case 'plans':
        this.renderer.setPlans(m.plans);
        break;
      case 'offset':
        this.offset = m.offset;
        break;
      case 'play':
        this.transport = m.transport;
        break;
      case 'stop':
        this.transport = null;
        break;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]?.[0];
    if (!out) return true;
    out.fill(0);
    const t = this.transport;
    if (!t || this.renderer.length === 0) return true;
    const n = Math.min(out.length, ENGINE_BLOCK);
    const count = blockRuns(currentFrame, n, t, this.runs);
    const clipStart = this.offset;
    const clipEnd = this.offset + this.renderer.length;
    for (let r = 0; r < count; r++) {
      const i = this.runs[r * 4];
      const p = this.runs[r * 4 + 1];
      const len = this.runs[r * 4 + 2];
      this.renderer.render(p - this.offset, len, out, i);
      const loop = t.loop;
      if (!loop) continue;
      const wrapped = this.runs[r * 4 + 3] === 1;
      // Only the few samples next to a loop boundary need a fade.
      if (p + len > loop.end - this.fade || (wrapped && p < loop.start + this.fade)) {
        for (let k = 0; k < len; k++) out[i + k] *= loopFade(p + k, wrapped, loop, clipStart, clipEnd, this.fade);
      }
    }
    return true;
  }
}

registerProcessor(ENGINE_PROCESSOR, VoiceEngineProcessor);
