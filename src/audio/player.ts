// Plays one recording with play/pause/seek and a clock the piano roll can follow.

export class Player {
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private startedAt = 0;
  private offset = 0;
  private _playing = false;

  /** Called when playback reaches the end on its own. */
  onEnded: (() => void) | null = null;

  get playing(): boolean {
    return this._playing;
  }

  get duration(): number {
    return this.buffer?.duration ?? 0;
  }

  /** Playback position in seconds, compensated for output latency so visuals match what you hear. */
  get currentTime(): number {
    if (!this._playing || !this.ctx) return this.offset;
    const latency = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    const t = this.offset + this.ctx.currentTime - this.startedAt - latency;
    return Math.min(this.duration, Math.max(this.offset, t));
  }

  load(samples: Float32Array, sampleRate: number): void {
    this.stopSource();
    this.ctx ??= new AudioContext();
    const buffer = this.ctx.createBuffer(1, Math.max(1, samples.length), sampleRate);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    this.buffer = buffer;
    this.offset = 0;
    this._playing = false;
  }

  /** Replaces the audio but keeps the position and play state (A/B switching, re-tuned audio). */
  swap(samples: Float32Array, sampleRate: number): void {
    if (!this.ctx || !this.buffer) {
      this.load(samples, sampleRate);
      return;
    }
    const wasPlaying = this._playing;
    const time = this.currentTime;
    this.stopSource();
    this._playing = false;
    const buffer = this.ctx.createBuffer(1, Math.max(1, samples.length), sampleRate);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    this.buffer = buffer;
    this.offset = Math.min(time, this.duration);
    if (wasPlaying) void this.play();
  }

  unload(): void {
    this.stopSource();
    this.buffer = null;
    this.offset = 0;
    this._playing = false;
  }

  async play(): Promise<void> {
    if (!this.ctx || !this.buffer || this._playing) return;
    if (this.offset >= this.duration - 0.01) this.offset = 0;
    await this.ctx.resume();
    const source = new AudioBufferSourceNode(this.ctx, { buffer: this.buffer });
    source.connect(this.ctx.destination);
    source.onended = () => {
      if (this.source !== source) return; // stopped by pause/seek, not by reaching the end
      this.source = null;
      this._playing = false;
      this.offset = this.duration;
      this.onEnded?.();
    };
    source.start(0, this.offset);
    this.source = source;
    this.startedAt = this.ctx.currentTime;
    this._playing = true;
  }

  pause(): void {
    if (!this._playing) return;
    this.offset = this.currentTime;
    this.stopSource();
    this._playing = false;
  }

  seek(time: number): void {
    const wasPlaying = this._playing;
    this.pause();
    this.offset = Math.min(this.duration, Math.max(0, time));
    if (wasPlaying) void this.play();
  }

  private stopSource(): void {
    const s = this.source;
    this.source = null;
    if (s) {
      s.onended = null;
      s.stop();
      s.disconnect();
    }
  }
}
