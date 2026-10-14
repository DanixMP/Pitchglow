// The audio engine: live input + pitch tracking, recording takes, the takes library, playback,
// and rendering the processed (cleaned/tuned) version. Owns everything that isn't plain state
// (buffers, audio nodes, workers) and publishes plain state to the store for the UI.

import { AudioInput } from '../audio/audio-input';
import { Player } from '../audio/player';
import { PitchTracker, type PitchFrame } from '../audio/pitch-tracker';
import { SampleBuffer } from '../audio/sample-buffer';
import { TunedRenderer } from '../audio/tuned-renderer';
import { wavBlob } from '../audio/wav';
import { packFrames, unpackFrames } from '../storage/pitch-track';
import { RecordingStore, type RecordingMeta } from '../storage/recording-store';
import type { PianoRoll } from '../ui/piano-roll';
import { processedLabelOf, processSettingsOf, tuneSettingsOf, wantsProcessed } from './processing';
import type { AppStore } from './state';

const MIN_RECORDING_SECONDS = 0.3;

interface LoadedRecording {
  meta: RecordingMeta;
  samples: Float32Array;
  frames: PitchFrame[];
}

interface OpenRecording extends LoadedRecording {
  /** Processed render of `samples` (cleaned and/or tuned), and the settings it was rendered with. */
  processed: Float32Array | null;
  processedFor: string | null;
}

export class Session {
  readonly player = new Player();
  private readonly input = new AudioInput((block) => this.onBlock(block));
  private readonly renderer = new TunedRenderer();
  private db: RecordingStore | null = null;

  private sampleRate = 0;
  private tracker: PitchTracker | null = null;
  private take: { audio: SampleBuffer; frames: PitchFrame[] } | null = null;
  private open: OpenRecording | null = null;
  /** The array the player currently has loaded. */
  private playerSource: Float32Array | null = null;
  private renderTimer = 0;
  /** Start playback once the processed render arrives (Play pressed on a just-opened recording). */
  private playWhenProcessed = false;
  /** Serialises actions so fast double-clicks can't interleave async start/stop. */
  private busy: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: AppStore,
    private readonly roll: PianoRoll,
  ) {}

  /** Runs an action after any previous one finished; errors end up in the status line. */
  run(action: () => Promise<void>): void {
    this.busy = this.busy.then(action).catch((err) => {
      console.error(err);
      this.store.set({ status: describeError(err) });
    });
  }

  // --- live input -----------------------------------------------------------------------------

  /** Starts (or restarts) the live pitch line, optionally recording. Keeps a running input if possible. */
  async startLive(record: boolean): Promise<void> {
    this.closeRecording();
    const { source, cleanup } = this.store.get();
    const micFilter = source === 'mic' && cleanup.micFilter;
    if (this.input.kind !== source || this.input.noiseSuppression !== micFilter) {
      this.sampleRate = await this.input.start(source, { noiseSuppression: micFilter });
    }
    this.tracker = new PitchTracker(this.sampleRate, (f) => this.onFrame(f));
    this.take = record ? { audio: new SampleBuffer(), frames: [] } : null;
    this.roll.start();
    this.store.set({ mode: record ? 'recording' : 'listening', recordingSeconds: 0, status: '' });
  }

  async stopLive(): Promise<void> {
    const finished = this.take;
    this.take = null;
    this.tracker = null;
    await this.input.stop();
    this.roll.stop();
    this.store.set({ mode: 'idle' });
    if (finished) await this.saveTake(finished);
  }

  get isLive(): boolean {
    const { mode } = this.store.get();
    return mode === 'listening' || mode === 'recording';
  }

  private onBlock(block: Float32Array): void {
    this.take?.audio.push(block);
    this.tracker?.push(block);
  }

  private onFrame(frame: PitchFrame): void {
    this.take?.frames.push(frame);
    this.roll.push(frame);
  }

  /** Seconds captured in the current take (for the heading timer). */
  get takeSeconds(): number {
    return this.take && this.sampleRate ? this.take.audio.length / this.sampleRate : 0;
  }

  private async saveTake(t: { audio: SampleBuffer; frames: PitchFrame[] }): Promise<void> {
    const samples = t.audio.toFloat32();
    const duration = samples.length / this.sampleRate;
    if (duration < MIN_RECORDING_SECONDS) {
      this.store.set({ status: 'Recording was too short to save.' });
      return;
    }
    const meta: RecordingMeta = {
      id: crypto.randomUUID(),
      name: nextRecordingName(this.store.get().recordings),
      createdAt: Date.now(),
      duration,
      sampleRate: this.sampleRate,
    };
    const db = await this.getDb();
    await db.save(meta, { id: meta.id, samples, pitch: packFrames(t.frames) });
    void navigator.storage?.persist?.(); // ask the browser not to evict recordings under storage pressure
    this.store.set({ recordings: await db.list() });
    this.showRecording({ meta, samples, frames: t.frames }, false);
  }

  // --- takes library --------------------------------------------------------------------------

  private async getDb(): Promise<RecordingStore> {
    this.db ??= await RecordingStore.open();
    return this.db;
  }

  async refreshList(): Promise<void> {
    this.store.set({ recordings: await (await this.getDb()).list() });
  }

  openRecording(id: string, autoplay: boolean): void {
    this.run(async () => {
      if (this.isLive) await this.stopLive();
      if (this.open?.meta.id !== id) {
        const meta = this.store.get().recordings.find((r) => r.id === id);
        const data = await (await this.getDb()).load(id);
        if (!meta || !data) throw new Error('Recording not found');
        this.showRecording({ meta, samples: data.samples, frames: unpackFrames(data.pitch) }, autoplay);
      } else if (autoplay) {
        this.player.seek(0);
        await this.player.play();
      }
    });
  }

  private showRecording(rec: LoadedRecording, autoplay: boolean): void {
    this.open = { ...rec, processed: null, processedFor: null };
    this.player.load(rec.samples, rec.meta.sampleRate);
    this.playerSource = rec.samples;
    // Start "at the end" so the last few seconds are visible; Play restarts from the beginning.
    this.player.seek(autoplay ? 0 : rec.meta.duration);
    this.roll.showRecording(rec.frames, rec.meta.duration, this.player.currentTime);
    this.store.set({ mode: 'playback', openId: rec.meta.id, render: { busy: false, ready: false, notes: [] } });
    // If we're going to listen to the processed version, wait for it rather than switching mid-play.
    this.playWhenProcessed = autoplay && wantsProcessed(this.store.get());
    this.scheduleRender(0);
    if (autoplay && !this.playWhenProcessed) void this.player.play();
  }

  closeRecording(): void {
    if (!this.open) return;
    window.clearTimeout(this.renderTimer);
    this.renderer.cancel();
    this.playWhenProcessed = false;
    this.player.unload();
    this.playerSource = null;
    this.open = null;
    this.roll.clear();
    this.store.set({ openId: null, render: { busy: false, ready: false, notes: [] } });
  }

  renameRecording(id: string, name: string): void {
    this.run(async () => {
      await (await this.getDb()).rename(id, name);
      if (this.open?.meta.id === id) this.open.meta = { ...this.open.meta, name };
      await this.refreshList();
    });
  }

  deleteRecording(id: string): void {
    this.run(async () => {
      await (await this.getDb()).delete(id);
      if (this.open?.meta.id === id) {
        this.closeRecording();
        this.store.set({ mode: 'idle' });
      }
      await this.refreshList();
    });
  }

  exportRecording(id: string): void {
    this.run(async () => {
      const meta = this.store.get().recordings.find((r) => r.id === id);
      const samples = this.open?.meta.id === id ? this.open.samples : (await (await this.getDb()).load(id))?.samples;
      if (!meta || !samples) throw new Error('Recording not found');
      downloadWav(samples, meta.sampleRate, meta.name);
    });
  }

  exportProcessed(): void {
    const { tuning, cleanup } = this.store.get();
    if (this.open?.processed) {
      const label = processedLabelOf(tuning, cleanup).toLowerCase();
      downloadWav(this.open.processed, this.open.meta.sampleRate, `${this.open.meta.name} (${label})`);
    }
  }

  // --- playback -------------------------------------------------------------------------------

  togglePlay(): void {
    if (!this.open) return;
    if (this.player.playing) this.player.pause();
    else void this.player.play();
  }

  seek(time: number): void {
    this.player.seek(time);
    this.roll.setTime(this.player.currentTime);
  }

  setListenProcessed(on: boolean): void {
    this.store.set({ listenProcessed: on });
    this.updatePlaybackSource();
  }

  /** Called when tuning or clean-up prefs change: update the roll, re-render the open take. */
  settingsChanged(): void {
    this.roll.setTuning(tuneSettingsOf(this.store.get().tuning));
    this.scheduleRender();
  }

  // --- processed audio (noise reduction + auto-tune + harmony) --------------------------------

  /** (Re-)renders the open recording's processed audio in the worker; debounced while controls move. */
  private scheduleRender(delay = 120): void {
    window.clearTimeout(this.renderTimer);
    const rec = this.open;
    if (!rec) return;
    const { tuning, cleanup } = this.store.get();
    const settings = processSettingsOf(tuning, cleanup);
    if (!settings) {
      this.renderer.cancel();
      this.updatePlaybackSource();
      this.setRender({ busy: false });
      return;
    }
    const key = JSON.stringify(settings);
    if (rec.processedFor === key) return;
    this.setRender({ busy: true });
    this.renderTimer = window.setTimeout(async () => {
      try {
        const out = await this.renderer.render(rec.meta.id, rec.samples, rec.meta.sampleRate, rec.frames, settings);
        if (!out || this.open !== rec) return; // superseded or closed
        rec.processed = out.output;
        rec.processedFor = key;
        this.setRender({ ready: true, notes: out.notes });
        this.updatePlaybackSource();
      } catch (err) {
        console.error(err);
        this.store.set({ status: describeError(err) });
      } finally {
        if (this.open === rec && !this.renderer.busy) {
          this.setRender({ busy: false });
          if (this.playWhenProcessed) {
            this.playWhenProcessed = false;
            void this.player.play();
          }
        }
      }
    }, delay);
  }

  private setRender(patch: Partial<{ busy: boolean; ready: boolean; notes: string[] }>): void {
    this.store.set((s) => ({ render: { ...s.render, ...patch } }));
  }

  /** Points the player at the processed or original audio, keeping position and play state. */
  private updatePlaybackSource(): void {
    const rec = this.open;
    if (!rec) return;
    const next = wantsProcessed(this.store.get()) && rec.processed ? rec.processed : rec.samples;
    if (next === this.playerSource) return;
    this.player.swap(next, rec.meta.sampleRate);
    this.playerSource = next;
  }
}

function nextRecordingName(recordings: readonly RecordingMeta[]): string {
  const used = recordings.map((r) => /^Recording (\d+)$/.exec(r.name)?.[1]).filter(Boolean).map(Number);
  return `Recording ${Math.max(0, ...used) + 1}`;
}

export function downloadWav(samples: Float32Array, sampleRate: number, name: string): void {
  const url = URL.createObjectURL(wavBlob(samples, sampleRate));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.replace(/[\\/:*?"<>|]+/g, '_')}.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function describeError(err: unknown): string {
  if (err instanceof DOMException && err.name === 'NotAllowedError') {
    return 'Microphone access was blocked. Allow it in the browser’s site settings and try again.';
  }
  if (err instanceof DOMException && err.name === 'NotFoundError') return 'No microphone found.';
  return `Something went wrong: ${err instanceof Error ? err.message : String(err)}`;
}
