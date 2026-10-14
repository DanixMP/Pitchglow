// AudioWorklet processor: forwards mono input to the main thread in fixed-size blocks.
// Runs on the audio rendering thread, so it does no analysis itself.

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

const BLOCK_SIZE = 512;

class CaptureProcessor extends AudioWorkletProcessor {
  private block = new Float32Array(BLOCK_SIZE);
  private filled = 0;

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    let i = 0;
    while (i < channel.length) {
      const n = Math.min(channel.length - i, BLOCK_SIZE - this.filled);
      this.block.set(channel.subarray(i, i + n), this.filled);
      this.filled += n;
      i += n;
      if (this.filled === BLOCK_SIZE) {
        this.port.postMessage(this.block, [this.block.buffer]);
        this.block = new Float32Array(BLOCK_SIZE);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);

export {};
