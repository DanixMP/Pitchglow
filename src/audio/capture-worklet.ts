// AudioWorklet processor: forwards mono input to the main thread in fixed-size blocks, each stamped
// with the context frame of its first sample (so takes can be aligned to song playback exactly).
// Runs on the audio rendering thread, so it does no analysis itself.

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;
/** Frame index (in the context's clock) of the first sample of the current render quantum. */
declare const currentFrame: number;

const BLOCK_SIZE = 512;

export interface CaptureMessage {
  samples: Float32Array;
  /** Context frame of samples[0]. */
  frame: number;
}

class CaptureProcessor extends AudioWorkletProcessor {
  private block = new Float32Array(BLOCK_SIZE);
  private filled = 0;
  private blockFrame = 0;

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    let i = 0;
    while (i < channel.length) {
      if (this.filled === 0) this.blockFrame = currentFrame + i;
      const n = Math.min(channel.length - i, BLOCK_SIZE - this.filled);
      this.block.set(channel.subarray(i, i + n), this.filled);
      this.filled += n;
      i += n;
      if (this.filled === BLOCK_SIZE) {
        const msg: CaptureMessage = { samples: this.block, frame: this.blockFrame };
        this.port.postMessage(msg, [this.block.buffer]);
        this.block = new Float32Array(BLOCK_SIZE);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
