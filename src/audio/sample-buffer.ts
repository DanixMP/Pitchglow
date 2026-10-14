// Collects incoming sample blocks while recording, then joins them into one array.

export class SampleBuffer {
  private blocks: Float32Array[] = [];
  private count = 0;

  get length(): number {
    return this.count;
  }

  push(block: Float32Array): void {
    this.blocks.push(block);
    this.count += block.length;
  }

  toFloat32(): Float32Array {
    const out = new Float32Array(this.count);
    let offset = 0;
    for (const b of this.blocks) {
      out.set(b, offset);
      offset += b.length;
    }
    return out;
  }
}
