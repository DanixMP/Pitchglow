// AudioWorklet processor for the live input (Phase 14). One node does everything the mic needs:
// - forwards the raw input in 512-sample blocks stamped with their context frame (takes stay dry and
//   line up with playback exactly);
// - runs the pitch tracker and posts every frame (the pitch line and the live auto-tune share one
//   detector);
// - when monitoring ("Hear myself") is on, outputs the voice processed live by LiveVoice: auto-tune,
//   harmony, transpose, with a fixed 25 ms delay (passed straight through when nothing is on);
// - estimates its own CPU load and drops harmony voices when it can't keep up.

import { LiveVoice, MAX_HARMONIES } from '../../dsp/live-voice';
import type { PitchFrame } from '../pitch-tracker';
import { LIVE_PROCESSOR, type LiveMessage, type LiveSettingsMessage } from './live-protocol';

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;
declare const currentFrame: number;
declare const sampleRate: number;

const BLOCK_SIZE = 512;
/** How often the load is reported, seconds of audio. */
const LOAD_WINDOW = 0.5;

class LiveProcessor extends AudioWorkletProcessor {
  private readonly voice = new LiveVoice(sampleRate);
  private block = new Float32Array(BLOCK_SIZE);
  private filled = 0;
  private blockFrame = 0;
  /** Context frame of the voice's sample 0. */
  private origin = -1;
  private monitor = false;
  private wantedHarmonies = 0;

  // Load estimate: count millisecond ticks of Date.now() that happen *during* process(). Summed over
  // many blocks this is an unbiased measure of the time spent, even with a 1 ms clock.
  private busyMs = 0;
  private windowFrames = 0;
  private calm = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<LiveSettingsMessage>) => {
      const m = e.data;
      this.monitor = m.monitor;
      this.wantedHarmonies = m.monitor ? Math.min(m.tune?.harmony?.voices.length ?? 0, MAX_HARMONIES) : 0;
      // Without monitoring only the pitch tracker runs (no synthesis work).
      this.voice.setSettings(m.monitor ? { tune: m.tune, semitones: m.semitones, voice: m.voice } : { tune: null, semitones: 0 });
    };
    this.voice.onFrame = (frame: PitchFrame, position: number) => {
      const msg: LiveMessage = { type: 'frame', frame, at: this.origin + position };
      this.port.postMessage(msg);
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const started = Date.now();
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!input || !output) return true;
    if (this.origin < 0) this.origin = currentFrame;

    // Raw blocks for recording.
    let i = 0;
    while (i < input.length) {
      if (this.filled === 0) this.blockFrame = currentFrame + i;
      const n = Math.min(input.length - i, BLOCK_SIZE - this.filled);
      this.block.set(input.subarray(i, i + n), this.filled);
      this.filled += n;
      i += n;
      if (this.filled === BLOCK_SIZE) {
        const msg: LiveMessage = { type: 'block', samples: this.block, frame: this.blockFrame };
        this.port.postMessage(msg, [this.block.buffer]);
        this.block = new Float32Array(BLOCK_SIZE);
        this.filled = 0;
      }
    }

    this.voice.process(input, output);
    if (!this.monitor) output.fill(0);

    this.busyMs += Date.now() - started;
    this.windowFrames += input.length;
    if (this.windowFrames >= LOAD_WINDOW * sampleRate) this.reportLoad();
    return true;
  }

  private reportLoad(): void {
    const load = this.busyMs / ((this.windowFrames / sampleRate) * 1000);
    this.busyMs = 0;
    this.windowFrames = 0;
    // Too slow: drop a harmony voice. Comfortably fast for a while: bring one back.
    if (load > 0.5 && this.voice.maxHarmonies > 0) {
      this.voice.maxHarmonies = Math.max(0, Math.min(this.voice.maxHarmonies, this.wantedHarmonies) - 1);
      this.calm = 0;
    } else if (load < 0.2 && this.voice.maxHarmonies < MAX_HARMONIES && ++this.calm >= 4) {
      this.voice.maxHarmonies++;
      this.calm = 0;
    }
    const msg: LiveMessage = { type: 'load', load, degraded: this.voice.maxHarmonies < this.wantedHarmonies, delay: this.voice.processing ? this.voice.delay : 0 };
    this.port.postMessage(msg);
  }
}

registerProcessor(LIVE_PROCESSOR, LiveProcessor);
