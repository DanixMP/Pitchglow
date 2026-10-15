import { describe, expect, it } from 'vitest';
import { computePeaks } from '../src/audio/peaks';
import { crc32, createZip } from '../src/audio/zip';
import { History } from '../src/project/history';

describe('computePeaks', () => {
  it('takes the max |sample| per bucket across channels', () => {
    const a = new Float32Array([0.1, -0.5, 0.2, 0.0, 0.3, -0.1]);
    const b = new Float32Array([0.0, 0.0, 0.0, -0.9, 0.0, 0.0]);
    expect([...computePeaks([a, b], 2, 1)].map((v) => +v.toFixed(2))).toEqual([0.5, 0.9, 0.3]); // 2 samples per bucket
  });

  it('sizes buckets from the sample rate', () => {
    expect(computePeaks([new Float32Array(48000)], 48000).length).toBe(100);
    expect(computePeaks([new Float32Array(44100 * 2)], 44100).length).toBe(200);
  });
});

describe('History', () => {
  it('undoes and redoes snapshots', () => {
    const h = new History<number>();
    h.push(1, null, 0); // 1 -> 2
    h.push(2, null, 10); // 2 -> 3
    expect(h.undo(3)).toBe(2);
    expect(h.undo(2)).toBe(1);
    expect(h.canUndo).toBe(false);
    expect(h.redo(1)).toBe(2);
    expect(h.redo(2)).toBe(3);
    expect(h.canRedo).toBe(false);
  });

  it('coalesces a drag into one step', () => {
    const h = new History<number>();
    h.push(0, 'gain:a', 0); // fader drag starts at 0
    h.push(1, 'gain:a', 100);
    h.push(2, 'gain:a', 200);
    expect(h.undo(3)).toBe(0); // one undo goes all the way back
    expect(h.canUndo).toBe(false);
  });

  it('keeps a slow gesture (its own key, no time limit) as one step', () => {
    const h = new History<number>();
    h.push(0, 'notedrag:1', 0, Infinity);
    h.push(1, 'notedrag:1', 5000, Infinity); // the user paused mid-drag
    expect(h.undo(2)).toBe(0);
    expect(h.canUndo).toBe(false);
  });

  it('does not coalesce different targets or slow edits', () => {
    const h = new History<number>();
    h.push(0, 'gain:a', 0);
    h.push(1, 'gain:b', 100);
    h.push(2, 'gain:b', 5000);
    expect(h.undo(3)).toBe(2);
    expect(h.undo(2)).toBe(1);
    expect(h.undo(1)).toBe(0);
  });

  it('a new edit clears redo and the stack is bounded', () => {
    const h = new History<number>(3);
    for (let i = 0; i < 5; i++) h.push(i, null, i * 1000);
    h.undo(5);
    h.push(9, null, 99999);
    expect(h.canRedo).toBe(false);
    let n = 0;
    let cur = 10;
    for (let s = h.undo(cur); s !== null; s = h.undo(cur)) {
      cur = s;
      n++;
    }
    expect(n).toBe(3);
  });
});

describe('createZip', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('writes a readable stored zip', () => {
    const files = [
      { name: 'a.wav', data: new Uint8Array([1, 2, 3]) },
      { name: 'stems/Vocal ünï.wav', data: new Uint8Array(1000).fill(7) },
    ];
    const zip = createZip(files, new Date(2026, 9, 14, 12, 30, 10));
    const v = new DataView(zip.buffer);
    // End of central directory
    const eocd = zip.length - 22;
    expect(v.getUint32(eocd, true)).toBe(0x06054b50);
    expect(v.getUint16(eocd + 10, true)).toBe(2);
    const cdOffset = v.getUint32(eocd + 16, true);
    // Walk the central directory and read each entry back through its local header.
    let p = cdOffset;
    for (const f of files) {
      expect(v.getUint32(p, true)).toBe(0x02014b50);
      const nameLen = v.getUint16(p + 28, true);
      const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));
      expect(name).toBe(f.name);
      const local = v.getUint32(p + 42, true);
      expect(v.getUint32(local, true)).toBe(0x04034b50);
      const size = v.getUint32(local + 18, true);
      const dataStart = local + 30 + v.getUint16(local + 26, true);
      const data = zip.subarray(dataStart, dataStart + size);
      expect([...data]).toEqual([...f.data]);
      expect(v.getUint32(local + 14, true)).toBe(crc32(data));
      p += 46 + nameLen;
    }
  });
});
