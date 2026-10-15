// The audio engine: live input + pitch tracking, recording takes, the takes library, songs
// (projects with tracks), playback, and rendering the processed (cleaned/tuned) audio.
// Owns everything that isn't plain state (buffers, audio nodes, workers) and publishes plain state
// to the store for the UI.
//
// Two playback contexts:
// - take preview (no song open): one take, edited with the global settings;
// - song: all its tracks play together; the inspector edits the *selected* track's settings
//   (they are loaded into store.tuning/cleanup and written back to the track on change).

import { AudioInput } from '../audio/audio-input';
import { outputLatency, sharedContext } from '../audio/context';
import { scheduleClicks } from '../audio/metronome';
import { alignTake, countInTimes, detectClickLatency } from '../audio/sync';
import { downmix } from '../dsp/analyze';
import type { Scale } from '../dsp/scales';
import { MixPlayer, type MixTrackSpec } from '../audio/mix-player';
import { exportLength, renderMix, renderStems, renderVoice } from '../audio/mixdown';
import type { ProcessSettings } from '../dsp/process';
import type { VoicePlans } from '../dsp/voice-engine';
import { songFxOf, trackFxOf, withPreset, FX_PRESETS, type FxPresetId, type SongFx, type TrackFx } from '../project/fx';
import { isNeutralVoice, presetPitch, trackVoiceOf, withVoicePreset, type TrackVoice, type VoicePresetId } from '../project/voice';
import type { VoiceCharacter } from '../dsp/voice-engine';
import { createZip } from '../audio/zip';
import { peaksOf } from '../audio/peaks';
import type { TimelineClip } from '../ui/timeline';
import { History } from '../project/history';
import type { PitchFrame } from '../audio/pitch-tracker';
import { SampleBuffer } from '../audio/sample-buffer';
import { TunedRenderer } from '../audio/tuned-renderer';
import { encodeWavChannels } from '../audio/wav';
import { encodeAudio } from '../audio/encode';
import { packSong, prepareImport, unpackSong, SONG_FILE_EXT } from '../project/package';
import {
  activeLoop,
  addTrack,
  applyKey,
  createInstrumentalTrack,
  createProject,
  createVocalTrack,
  defaultLoop,
  duplicateProject as duplicateProjectModel,
  effectiveGain,
  masterOf,
  newId,
  normalizeLoop,
  trackSemitones,
  transposeScale,
  nextProjectName,
  removeTrack as removeTrackModel,
  titleFromFileName,
  updateTrack as updateTrackModel,
  withInstrumental,
  withoutTake,
  type Project,
  type Track,
} from '../project/model';
import { packFrames, unpackFrames } from '../storage/pitch-track';
import { RecordingStore, type Asset, type RecordingMeta } from '../storage/recording-store';
import type { CleanupPrefs, TuningPrefs } from '../storage/settings';
import type { PianoRoll } from '../ui/piano-roll';
import { processedLabelOf, processSettingsOf, trackProcessSettings, tuneSettingsOf, wantsProcessed } from './processing';
import { openProject, type AppStore, type RenderState } from './state';

const MIN_RECORDING_SECONDS = 0.3;
/** Imported instrumentals: limits that keep memory sane on phones. */
const MAX_IMPORT_BYTES = 80 * 1024 * 1024;
const MAX_IMPORT_SECONDS = 15 * 60;
const IMPORT_EXTENSIONS = /\.(mp3|wav|wave|m4a|aac|mp4|ogg|oga|opus|flac|webm)$/i;
/** Count-in tempo when the song has no detected BPM. */
const DEFAULT_BPM = 100;
const PREVIEW_CHANNEL = 'preview';
const SAVE_DELAY_MS = 400;

interface LoadedTake {
  meta: RecordingMeta;
  samples: Float32Array;
  frames: PitchFrame[];
}

/** A take's voice-engine input: the cleaned source (worker) and the grain plans for its settings. */
interface Voice {
  /** Cleaned source at the playback rate (null = not ready / nothing to clean). */
  source: Float32Array | null;
  /** Worker version of `source`. */
  version: number;
  /** Clean-up input last sent to the worker. */
  sentKey: string | null;
  plans: VoicePlans | null;
}

const newVoice = (): Voice => ({ source: null, version: 0, sentKey: null, plans: null });

export class Session {
  readonly player = new MixPlayer();
  private readonly input = new AudioInput({
    onBlock: (block, time) => this.onBlock(block, time),
    onFrame: (frame, time) => this.onFrame(frame, time),
    onStats: (stats) => this.onLiveStats(stats),
  });
  private readonly renderer = new TunedRenderer();
  private db: RecordingStore | null = null;

  private sampleRate = 0;
  /** Context time the live pitch line counts from (when Listen/Record started). */
  private liveOrigin = 0;
  private take: { audio: SampleBuffer; frames: PitchFrame[]; firstTime: number | null } | null = null;
  /** Recording over the song: when/where playback started, for aligning the take afterwards. */
  private sync: { playStart: number; songPosition: number; latency: number } | null = null;
  /** Calibration listens to raw blocks instead of the tracker. */
  private blockSink: ((block: Float32Array, time: number) => void) | null = null;
  /** Decoded instrumentals by asset id. */
  private assets = new Map<string, AudioBuffer>();
  /** Key-shifted instrumentals by `assetId|semitones` (phase vocoder in the worker). */
  private shiftedAssets = new Map<string, AudioBuffer>();

  /** Take preview (no song open). */
  private preview: (LoadedTake & { voice: Voice }) | null = null;
  /** Loaded takes (audio + pitch) for the open song, by take id. */
  private takes = new Map<string, LoadedTake>();
  /** Voice-engine inputs for the open song's vocal tracks, by track id. */
  private voices = new Map<string, Voice>();
  private renderTimers = new Map<string, number>();
  /** Global settings, stashed while a song's track settings occupy the inspector. */
  private stash: { tuning: TuningPrefs; cleanup: CleanupPrefs } | null = null;
  private saveTimers = new Map<string, number>();
  /** Undo/redo of the open song (snapshots). */
  private readonly history = new History<Project>();

  /** Start playback once the processed render arrives (Play pressed on a just-opened take). */
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

  async init(): Promise<void> {
    await this.player.loadEngine();
    const db = await this.getDb();
    const [recordings, projects] = await Promise.all([db.list(), db.listProjects()]);
    this.store.set({ recordings, projects });
    // Replaced/removed instrumentals are kept until the next start (so undo can bring them back),
    // then deleted here once no song references them.
    const used = new Set(projects.flatMap((p) => p.tracks.map((t) => t.assetId).filter(Boolean)));
    for (const id of await db.listAssetIds()) if (!used.has(id)) await db.deleteAsset(id);
  }

  // --- live input -----------------------------------------------------------------------------

  /** Starts (or restarts) the live pitch line, optionally recording. Keeps a running input if possible. */
  async startLive(record: boolean): Promise<void> {
    this.closePreview();
    this.player.pause();
    const { source, cleanup } = this.store.get();
    const micFilter = source === 'mic' && cleanup.micFilter;
    if (this.input.kind !== source || this.input.noiseSuppression !== micFilter) {
      this.sampleRate = await this.input.start(source, { noiseSuppression: micFilter });
    }
    this.liveOrigin = this.player.context.currentTime;
    this.take = record ? { audio: new SampleBuffer(), frames: [], firstTime: null } : null;
    this.roll.start();
    this.store.set({ mode: record ? 'recording' : 'listening', recordingSeconds: 0, status: '' });
    this.syncMonitor();
    const song = openProject(this.store.get());
    if (record && song && this.songIsAudible(song)) await this.playAlong(song);
  }

  /** Whether recording into this song should play it back (something audible to sing along to). */
  private songIsAudible(song: Project): boolean {
    return this.player.duration > 0 && song.tracks.some((t) => effectiveGain(t, song.tracks) > 0);
  }

  /**
   * Plays the song (optionally after a one-bar count-in) while the take records, and remembers the
   * timing so the take can be placed exactly where it was sung (see sync.ts).
   */
  private async playAlong(song: Project): Promise<void> {
    const ctx = this.player.context;
    const { input } = this.store.get();
    this.player.setLoop(null); // the take is recorded straight through
    const end = this.player.duration;
    const position = this.player.currentTime >= end - 0.05 ? 0 : this.player.currentTime;
    this.player.seek(position);
    let startAt = ctx.currentTime + 0.12;
    if (input.countIn) {
      const count = countInTimes(startAt, song.bpm ?? DEFAULT_BPM);
      scheduleClicks(ctx, count.clicks);
      startAt = count.end;
    }
    const playStart = await this.player.play(startAt);
    const latency = input.calibratedMs !== null ? input.calibratedMs / 1000 : outputLatency(ctx) + this.input.inputLatency;
    this.sync = { playStart, songPosition: position, latency };
    // Other tracks as ghosts on the live roll, lined up with what you hear.
    const toLive = position - (playStart - this.liveOrigin) - outputLatency(ctx);
    this.roll.setGhosts(
      song.tracks
        .filter((t) => t.kind === 'vocal' && t.takeId && this.takes.has(t.takeId))
        .map((t) => ({ frames: this.takes.get(t.takeId!)!.frames.map((f) => ({ ...f, time: f.time + t.offset - toLive })), hue: t.hue })),
    );
  }

  async stopLive(): Promise<void> {
    const finished = this.take;
    const sync = this.sync;
    this.take = null;
    this.sync = null;
    if (sync) this.player.pause();
    this.syncLoop();
    this.player.setMonitor(null);
    await this.input.stop();
    this.roll.stop();
    this.store.set({ mode: this.store.get().projectId ? 'playback' : 'idle', live: { load: 0, degraded: false, latencyMs: null } });
    if (finished) {
      const offset =
        sync && finished.firstTime !== null
          ? alignTake({
              playStart: sync.playStart,
              songPosition: sync.songPosition,
              firstSampleTime: finished.firstTime,
              outputLatency: sync.latency,
              inputLatency: 0,
              nudge: this.store.get().input.nudgeMs / 1000,
            })
          : 0;
      await this.saveTake(finished, offset);
    } else if (this.store.get().projectId) this.refreshSongView();
  }

  get isLive(): boolean {
    const { mode } = this.store.get();
    return mode === 'listening' || mode === 'recording';
  }

  private onBlock(block: Float32Array, time: number): void {
    if (this.blockSink) return this.blockSink(block, time);
    if (this.take) {
      if (this.take.firstTime === null) this.take.firstTime = time;
      this.take.audio.push(block);
    }
  }

  /** A pitch frame from the live worklet (`time` = context time of its window centre). */
  private onFrame(frame: PitchFrame, time: number): void {
    if (!this.isLive) return;
    const sinceStart = time - this.liveOrigin;
    if (sinceStart >= 0) this.roll.push({ ...frame, time: sinceStart });
    // Takes count from their first sample, so frames line up with the recorded audio exactly.
    const take = this.take;
    if (take && take.firstTime !== null && time >= take.firstTime) take.frames.push({ ...frame, time: time - take.firstTime });
  }

  // --- hear yourself (live monitoring, Phase 14) ----------------------------------------------

  /**
   * Points the live path at the current settings: monitoring on/off, the inspector's auto-tune and
   * harmony, and the selected track's effects. In a key-shifted song you sing in the shifted key, so
   * auto-tune snaps to the shifted scale and nothing is transposed (as the new track will play back).
   */
  syncMonitor(): void {
    const state = this.store.get();
    const monitor = state.input.monitor && this.isLive;
    const song = openProject(state);
    const tune = tuneSettingsOf(state.tuning);
    const shift = song?.keyShift ?? 0;
    const track = song?.tracks.find((t) => t.id === state.selectedTrackId && t.kind === 'vocal');
    // The selected track's voice character (and its preset's pitch) is what you hear while singing.
    const voice = track ? trackVoiceOf(track) : null;
    this.input.setProcessing({
      monitor,
      tune: tune && shift ? { ...tune, scale: transposeScale(tune.scale, shift) } : tune,
      semitones: voice ? presetPitch(voice) : 0,
      voice: voice && !isNeutralVoice(voice) ? { formant: voice.formant, whisper: voice.whisper, monotone: voice.monotone } : null,
    });
    this.player.setMonitor(monitor ? this.input.output : null, track ? trackFxOf(track) : undefined);
    if (!monitor && state.live.latencyMs !== null) this.store.set({ live: { ...state.live, latencyMs: null } });
  }

  private onLiveStats(stats: { load: number; degraded: boolean; delaySeconds: number }): void {
    const { input } = this.store.get();
    const ctx = this.player.context;
    // Mic -> worklet -> (processing delay) -> one render quantum -> speakers/headphones.
    const latency = input.monitor && this.isLive ? this.input.inputLatency + stats.delaySeconds + 128 / ctx.sampleRate + outputLatency(ctx) : null;
    this.store.set({ live: { load: stats.load, degraded: stats.degraded, latencyMs: latency === null ? null : Math.round(latency * 1000) } });
  }

  /** Seconds captured in the current take (for the heading timer). */
  get takeSeconds(): number {
    return this.take && this.sampleRate ? this.take.audio.length / this.sampleRate : 0;
  }

  private async saveTake(t: { audio: SampleBuffer; frames: PitchFrame[] }, offset = 0): Promise<void> {
    const samples = t.audio.toFloat32();
    const duration = samples.length / this.sampleRate;
    if (duration < MIN_RECORDING_SECONDS) {
      this.store.set({ status: 'Recording was too short to save.' });
      if (this.store.get().projectId) this.refreshSongView();
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
    const loaded = { meta, samples, frames: t.frames };
    if (this.store.get().projectId) {
      // Recording inside a song: the take becomes a new vocal track, with the settings it was sung with.
      this.takes.set(meta.id, loaded);
      const { tuning, cleanup } = this.store.get();
      this.addTrackFromTake(meta, tuning, cleanup, offset, true);
    } else {
      this.showPreview(loaded, false);
    }
  }

  // --- takes library --------------------------------------------------------------------------

  private async getDb(): Promise<RecordingStore> {
    this.db ??= await RecordingStore.open();
    return this.db;
  }

  async refreshList(): Promise<void> {
    this.store.set({ recordings: await (await this.getDb()).list() });
  }

  private async loadTake(id: string): Promise<LoadedTake> {
    const cached = this.takes.get(id);
    if (cached) return cached;
    const meta = this.store.get().recordings.find((r) => r.id === id);
    const data = await (await this.getDb()).load(id);
    if (!meta || !data) throw new Error('Take not found');
    const take = { meta, samples: data.samples, frames: unpackFrames(data.pitch) };
    this.takes.set(id, take);
    return take;
  }

  /** Opens a take for preview (closes any open song). */
  openRecording(id: string, autoplay: boolean): void {
    this.run(async () => {
      if (this.isLive) await this.stopLive();
      if (this.store.get().projectId) this.closeProjectNow();
      if (this.preview?.meta.id !== id) {
        this.showPreview(await this.loadTake(id), autoplay);
      } else if (autoplay) {
        this.player.seek(0);
        await this.player.play();
      }
    });
  }

  private showPreview(take: LoadedTake, autoplay: boolean): void {
    this.preview = { ...take, voice: newVoice() };
    this.player.load(take.samples, take.meta.sampleRate);
    // Start "at the end" so the last few seconds are visible; Play restarts from the beginning.
    this.player.seek(autoplay ? 0 : take.meta.duration);
    this.roll.setGhosts([]);
    this.roll.showRecording(take.frames, take.meta.duration, this.player.currentTime);
    this.store.set({
      mode: 'playback',
      openId: take.meta.id,
      duration: this.player.duration,
      render: { busy: false, ready: false, notes: [] },
    });
    // If we're going to listen to the processed version, wait for it rather than switching mid-play.
    this.playWhenProcessed = autoplay && wantsProcessed(this.store.get());
    this.schedulePreviewRender();
    if (autoplay && !this.playWhenProcessed) void this.player.play();
  }

  private closePreview(): void {
    if (!this.preview) return;
    this.cancelRender(PREVIEW_CHANNEL);
    this.playWhenProcessed = false;
    this.player.unload();
    this.preview = null;
    this.roll.clear();
    this.store.set({ openId: null, duration: 0, render: { busy: false, ready: false, notes: [] } });
  }

  /** Back to the empty idle screen (used when the open thing is deleted). */
  closeRecording(): void {
    this.closePreview();
  }

  renameRecording(id: string, name: string): void {
    this.run(async () => {
      await (await this.getDb()).rename(id, name);
      const cached = this.takes.get(id);
      if (cached) cached.meta = { ...cached.meta, name };
      if (this.preview?.meta.id === id) this.preview.meta = { ...this.preview.meta, name };
      await this.refreshList();
    });
  }

  /** Deletes a take; tracks that used it are removed from their songs. */
  deleteRecording(id: string): void {
    this.run(async () => {
      const db = await this.getDb();
      const changed = withoutTake(this.store.get().projects, id);
      await db.putProjects(changed);
      await db.delete(id);
      this.takes.delete(id);
      if (this.preview?.meta.id === id) {
        this.closePreview();
        this.store.set({ mode: 'idle' });
      }
      if (changed.length) {
        this.store.set((s) => ({ projects: s.projects.map((p) => changed.find((c) => c.id === p.id) ?? p) }));
        const open = openProject(this.store.get());
        if (open && changed.some((p) => p.id === open.id)) {
          for (const id of [...this.voices.keys()]) if (!open.tracks.some((t) => t.id === id)) this.dropVoice(id);
          const stillSelected = open.tracks.some((t) => t.id === this.store.get().selectedTrackId);
          if (!stillSelected) this.selectTrack(open.tracks[0]?.id ?? null);
          this.rebuildMix();
        }
      }
      await this.refreshList();
    });
  }

  exportRecording(id: string): void {
    this.run(async () => {
      const take = this.takes.get(id) ?? (this.preview?.meta.id === id ? this.preview : await this.loadTake(id));
      await this.download([take.samples], take.meta.sampleRate, take.meta.name);
    });
  }

  /** Transport export: the processed take (preview) or a mixdown of the song. */
  exportProcessed(): void {
    const state = this.store.get();
    const project = openProject(state);
    if (project) {
      this.run(async () => {
        const specs = this.mixSpecs(project);
        if (!specs.length) return;
        const rate = this.player.context.sampleRate; // the engine's plans are made at this rate
        const song = { fx: songFxOf(project), bpm: project.bpm ?? null };
        const mix = await renderMix(specs, rate, masterOf(project), exportLength(specs, song), song);
        await this.download(mix.channels, mix.sampleRate, `${project.name} (mix)`);
      });
    } else if (this.preview?.voice.source) {
      const label = processedLabelOf(state.tuning, state.cleanup).toLowerCase();
      const { voice, meta } = this.preview;
      const rate = this.player.context.sampleRate;
      this.run(async () => this.download([await renderVoice(voice.source!, rate, voice.plans)], rate, `${meta.name} (${label})`));
    }
  }

  /** Encodes in the chosen export format (WAV or MP3) and downloads. */
  private async download(channels: readonly Float32Array[], sampleRate: number, name: string): Promise<void> {
    const format = this.store.get().exportFormat;
    if (format === 'mp3') this.store.set({ status: 'Encoding MP3…' });
    try {
      downloadBlob(await encodeAudio(channels, sampleRate, format), name, format);
    } finally {
      if (format === 'mp3') this.store.set((st) => (st.status === 'Encoding MP3…' ? { status: '' } : {}));
    }
  }

  /** Clips for the timeline: every track of the open song with its waveform, in track order. */
  timelineClips(): TimelineClip[] {
    const state = this.store.get();
    const project = openProject(state);
    if (!project) return [];
    const clips: TimelineClip[] = [];
    for (const t of project.tracks) {
      const take = t.takeId ? this.takes.get(t.takeId) : undefined;
      const buffer = t.assetId ? this.assets.get(t.assetId) : undefined;
      if (!take && !buffer) continue;
      const audio = buffer ? { samples: EMPTY, sampleRate: buffer.sampleRate, buffer } : { samples: take!.samples, sampleRate: take!.meta.sampleRate };
      clips.push({
        id: t.id,
        color: t.hue < 0 ? '#8a8a90' : `hsl(${t.hue} 70% 62%)`,
        peaks: peaksOf(audio),
        offset: t.offset,
        duration: buffer ? buffer.duration : take!.meta.duration,
        muted: effectiveGain(t, project.tracks) === 0,
        selected: t.id === state.selectedTrackId,
      });
    }
    return clips;
  }

  /** Each audible track as its own stereo WAV (post fader + pan, same length), zipped. */
  exportStems(): void {
    const project = openProject(this.store.get());
    if (!project) return;
    this.run(async () => {
      const specs = this.mixSpecs(project);
      if (!specs.length) return;
      const rate = this.player.context.sampleRate;
      const stems = await renderStems(specs, rate, { fx: songFxOf(project), bpm: project.bpm ?? null });
      const width = String(project.tracks.length).length;
      const entries = stems.map(({ id, rendered }) => {
        const i = project.tracks.findIndex((t) => t.id === id);
        const name = `${String(i + 1).padStart(Math.max(2, width), '0')} ${safeName(project.tracks[i]?.name ?? 'track')}.wav`;
        return { name, data: new Uint8Array(encodeWavChannels(rendered.channels, rendered.sampleRate)) };
      });
      const zip = createZip(entries);
      downloadBlob(new Blob([zip as Uint8Array<ArrayBuffer>], { type: "application/zip" }), `${project.name} (stems)`, "zip");
    });
  }

  // --- songs (projects) -----------------------------------------------------------------------

  newProject(): void {
    this.run(async () => {
      const project = createProject(nextProjectName(this.store.get().projects));
      await (await this.getDb()).putProjects([project]);
      this.store.set((s) => ({ projects: [project, ...s.projects] }));
      await this.openProjectNow(project.id);
    });
  }

  openProject(id: string): void {
    this.run(() => this.openProjectNow(id));
  }

  private async openProjectNow(id: string): Promise<void> {
    if (this.isLive) await this.stopLive();
    if (this.store.get().projectId === id) return;
    if (this.store.get().projectId) this.closeProjectNow();
    this.closePreview();
    const project = this.store.get().projects.find((p) => p.id === id);
    if (!project) throw new Error('Song not found');
    for (const t of project.tracks) {
      if (t.takeId) await this.loadTake(t.takeId);
      if (t.assetId) await this.loadAsset(t.assetId).catch((err) => this.store.set({ status: describeError(err) }));
    }

    const { tuning, cleanup } = this.store.get();
    this.stash = { tuning, cleanup };
    const first = project.tracks.find((t) => t.kind === 'vocal') ?? null;
    this.history.clear();
    this.store.set({ projectId: id, selectedTrackId: null, mode: 'playback', trackRender: {}, detection: null, history: { canUndo: false, canRedo: false } });
    this.roll.setScaleHint(project.key ?? null);
    this.player.unload();
    this.selectTrack(first?.id ?? null);
    this.rebuildMix();
    this.player.seek(0);
    for (const t of project.tracks) {
      this.updateTrackVoice(t.id);
      if (t.kind === 'instrumental' && t.assetId) this.scheduleInstrumentalShift(t.id, t.assetId, project.keyShift);
    }
  }

  closeProject(): void {
    this.run(async () => {
      if (this.isLive) await this.stopLive();
      this.closeProjectNow();
    });
  }

  private closeProjectNow(): void {
    if (!this.store.get().projectId) return;
    this.flushSaves();
    this.history.clear();
    this.cancelRender();
    for (const t of this.renderTimers.values()) window.clearTimeout(t);
    this.renderTimers.clear();
    for (const id of [...this.voices.keys()]) this.dropVoice(id);
    this.player.setLoop(null);
    this.player.unload();
    this.roll.clear();
    this.roll.setScaleHint(null);
    const stash = this.stash;
    this.stash = null;
    this.store.set({
      projectId: null,
      selectedTrackId: null,
      trackRender: {},
      duration: 0,
      mode: 'idle',
      detection: null,
      history: { canUndo: false, canRedo: false },
      ...(stash ? { tuning: stash.tuning, cleanup: { ...stash.cleanup, micFilter: this.store.get().cleanup.micFilter } } : {}),
    });
  }

  renameProject(id: string, name: string): void {
    this.mutateProject(id, (p) => ({ ...p, name, updatedAt: Date.now() }));
  }

  duplicateProject(id: string): void {
    this.run(async () => {
      const src = this.store.get().projects.find((p) => p.id === id);
      if (!src) return;
      const copy = duplicateProjectModel(src, `${src.name} copy`);
      await (await this.getDb()).putProjects([copy]);
      this.store.set((s) => ({ projects: [copy, ...s.projects] }));
    });
  }

  deleteProject(id: string): void {
    this.run(async () => {
      if (this.store.get().projectId === id) this.closeProjectNow();
      window.clearTimeout(this.saveTimers.get(id));
      this.saveTimers.delete(id);
      await (await this.getDb()).deleteProject(id);
      this.store.set((s) => ({ projects: s.projects.filter((p) => p.id !== id) }));
    });
  }

  /** Saves a whole song (takes + instrumental file) as one .recsong file. */
  exportProjectFile(id: string): void {
    this.run(async () => {
      const project = this.store.get().projects.find((p) => p.id === id);
      if (!project) return;
      const db = await this.getDb();
      const takeIds = [...new Set(project.tracks.map((t) => t.takeId).filter((x): x is string => !!x))];
      const takes = [];
      for (const takeId of takeIds) {
        const take = await this.loadTake(takeId);
        takes.push({ meta: take.meta, samples: take.samples, pitch: packFrames(take.frames) });
      }
      const assets = [];
      for (const assetId of new Set(project.tracks.map((t) => t.assetId).filter((x): x is string => !!x))) {
        const asset = await db.getAsset(assetId);
        if (!asset) throw new Error('The instrumental file is missing.');
        assets.push(asset);
      }
      const file = packSong({ project, takes, assets });
      downloadBlob(new Blob([file], { type: 'application/zip' }), project.name, SONG_FILE_EXT);
    });
  }

  /** Imports a .recsong file as a new song (adding its takes to the library) and opens it. */
  importProjectFile(file: File): void {
    this.run(async () => {
      if (this.isLive) await this.stopLive();
      this.store.set({ importing: true, status: '' });
      try {
        const pkg = unpackSong(new Uint8Array(await file.arrayBuffer()));
        const db = await this.getDb();
        const state = this.store.get();
        const add = prepareImport(pkg, {
          projectNames: state.projects.map((p) => p.name),
          takeIds: new Set(state.recordings.map((r) => r.id)),
          assetIds: new Set(await db.listAssetIds()),
        });
        for (const t of add.takes) await db.save(t.meta, { id: t.meta.id, samples: t.samples, pitch: t.pitch });
        for (const a of add.assets) await db.putAsset(a);
        await db.putProjects([add.project]);
        void navigator.storage?.persist?.();
        this.store.set((st) => ({ projects: [add.project, ...st.projects] }));
        await this.refreshList();
        await this.openProjectNow(add.project.id);
        const n = add.takes.length;
        this.store.set({ status: `Imported “${add.project.name}”${n ? ` with ${n} new ${n === 1 ? 'take' : 'takes'}` : ''}.` });
      } finally {
        this.store.set({ importing: false });
      }
    });
  }

  /** Adds a library take to the open song as a new vocal track (with the global default settings). */
  addTakeToProject(takeId: string): void {
    this.run(async () => {
      if (!this.store.get().projectId) return;
      const take = await this.loadTake(takeId);
      const defaults = this.stash ?? { tuning: this.store.get().tuning, cleanup: this.store.get().cleanup };
      this.addTrackFromTake(take.meta, defaults.tuning, defaults.cleanup);
    });
  }

  /**
   * `sung`: the take was just recorded over this song. It then gets the selected track's effects
   * (what was heard while monitoring), and in a key-shifted song it was sung in the shifted key: its
   * auto-tune scale is shifted to match and its pitch offset cancels the key shift, so it plays back
   * as sung.
   */
  private addTrackFromTake(meta: RecordingMeta, tuning: TuningPrefs, cleanup: CleanupPrefs, offset = 0, sung = false): void {
    const project = openProject(this.store.get());
    if (!project) return;
    const shift = sung ? project.keyShift : 0;
    const sungTuning = shift ? { ...tuning, root: transposeScale({ root: tuning.root, type: tuning.type }, shift).root } : tuning;
    const selected = project.tracks.find((t) => t.id === this.store.get().selectedTrackId && t.kind === 'vocal');
    const track: Track = {
      ...createVocalTrack(meta, sungTuning, cleanup, project.tracks.filter((t) => t.kind === 'vocal')),
      offset,
      // Plays back as sung (+ the voice preset's pitch you heard while monitoring).
      pitch: -shift + (sung && selected ? presetPitch(trackVoiceOf(selected)) : 0),
      ...(sung && selected?.fx ? { fx: structuredClone(selected.fx) } : {}),
      ...(sung && selected?.voice ? { voice: { ...selected.voice } } : {}),
    };
    this.mutateProject(project.id, (p) => addTrack(p, track));
    this.selectTrack(track.id);
    this.rebuildMix();
    this.updateTrackVoice(track.id);
  }

  removeTrack(trackId: string): void {
    const project = openProject(this.store.get());
    if (!project) return;
    this.dropVoice(trackId);
    this.mutateProject(project.id, (p) => removeTrackModel(p, trackId));
    if (this.store.get().selectedTrackId === trackId) {
      const next = openProject(this.store.get())?.tracks.find((t) => t.kind === 'vocal')?.id ?? null;
      this.selectTrack(next);
    }
    this.rebuildMix();
  }

  /** Selects a track: its settings move into the inspector, its pitch line into the roll. */
  selectTrack(trackId: string | null): void {
    const state = this.store.get();
    const project = openProject(state);
    // Instrumentals have no auto-tune/clean-up: they can't take over the inspector.
    const track = project?.tracks.find((t) => t.id === trackId && t.kind === 'vocal') ?? null;
    const base = this.stash ?? { tuning: state.tuning, cleanup: state.cleanup };
    this.store.set({
      selectedTrackId: track?.id ?? null,
      // No track selected: the inspector shows the global defaults (used for new tracks).
      tuning: track ? track.tuning : base.tuning,
      cleanup: track ? { ...track.cleanup, micFilter: state.cleanup.micFilter } : { ...base.cleanup, micFilter: state.cleanup.micFilter },
    });
    this.refreshSongView();
  }

  /**
   * Mixer edits (fader, pan, mute, solo, name, clip position): applied live, saved shortly after,
   * undoable (a fader or clip drag is one undo step).
   */
  updateTrackMix(trackId: string, patch: Partial<Pick<Track, 'gainDb' | 'pan' | 'mute' | 'solo' | 'name' | 'offset'>>): void {
    const project = openProject(this.store.get());
    if (!project) return;
    const field = Object.keys(patch)[0];
    const coalesce = field === 'gainDb' || field === 'pan' || field === 'name' || field === 'offset' ? `${field}:${trackId}` : null;
    this.mutateProject(project.id, (p) => updateTrackModel(p, trackId, patch), coalesce);
    const tracks = openProject(this.store.get())!.tracks;
    if ('offset' in patch) {
      this.rebuildMix();
      return;
    }
    if ('pan' in patch) this.player.setPan(trackId, patch.pan!);
    for (const t of tracks) this.player.setGain(t.id, effectiveGain(t, tracks));
  }

  /** Master fader / limiter. */
  setMaster(patch: Partial<Pick<Project, 'masterGainDb' | 'limiter'>>): void {
    const project = openProject(this.store.get());
    if (!project) return;
    this.mutateProject(project.id, (p) => ({ ...p, ...patch, updatedAt: Date.now() }), 'masterGainDb' in patch ? 'master' : null);
    this.player.setMaster(masterOf(openProject(this.store.get())!));
  }

  /** Sets the loop region (drawn on the timeline ruler) and switches looping on. Not an undo step. */
  setLoopRegion(start: number, end: number): void {
    const project = openProject(this.store.get());
    if (!project) return;
    const region = normalizeLoop(start, end, project.bpm, this.player.duration, true);
    if (!region) return;
    this.mutateProject(project.id, (p) => ({ ...p, loop: { ...region, on: true }, updatedAt: Date.now() }), false);
    this.syncLoop();
  }

  /** Loop on/off (L). The first time, a loop of two bars (or 4 s) around the playhead is made. */
  toggleLoop(): void {
    const project = openProject(this.store.get());
    if (!project || this.player.duration <= 0) return;
    let loop = project.loop ? { ...project.loop, on: !project.loop.on } : null;
    if (!loop) {
      const region = defaultLoop(this.player.currentTime, project.bpm, this.player.duration);
      if (!region) return;
      loop = { ...region, on: true };
    }
    this.mutateProject(project.id, (p) => ({ ...p, loop, updatedAt: Date.now() }), false);
    this.syncLoop();
  }

  /** Points the player at the open song's loop (none while a take is being recorded over it). */
  private syncLoop(): void {
    const project = openProject(this.store.get());
    this.player.setLoop(project && !this.take ? activeLoop(project, this.player.duration) : null);
  }

  /** The inspector's tuning as the roll should draw it: moved by the selected track's transpose. */
  private rollTuning() {
    const state = this.store.get();
    const settings = tuneSettingsOf(state.tuning);
    const project = openProject(state);
    const track = project?.tracks.find((t) => t.id === state.selectedTrackId);
    if (!settings || !project || !track) return settings;
    return { ...settings, scale: transposeScale(settings.scale, trackSemitones(track, project)) };
  }

  /** Vocal-chain / send edits. Live parts apply instantly; gate/de-ess re-render the track. */
  updateTrackFx(trackId: string, patch: Partial<Omit<TrackFx, 'preset'>>): void {
    const project = openProject(this.store.get());
    const track = project?.tracks.find((t) => t.id === trackId);
    if (!project || !track) return;
    const fx: TrackFx = { ...trackFxOf(track), ...patch, eq: { ...trackFxOf(track).eq, ...patch.eq }, preset: null };
    this.mutateProject(project.id, (p) => updateTrackModel(p, trackId, { fx }), `fx:${trackId}:${Object.keys(patch).join(',')}`);
    this.player.setTrackFx(trackId, fx);
    if (this.isLive) this.syncMonitor();
    if ('gate' in patch || 'deess' in patch) this.updateTrackVoice(trackId);
  }

  /** Applies a vocal preset ("Robot" also sets hard auto-tune on the track). */
  /** Voice character edits (formant, whisper, robot): new plans, heard on the next block. */
  setTrackVoice(trackId: string, patch: Partial<VoiceCharacter>): void {
    const project = openProject(this.store.get());
    const track = project?.tracks.find((t) => t.id === trackId);
    if (!project || !track) return;
    const voice: TrackVoice = { ...trackVoiceOf(track), ...patch, preset: null };
    this.mutateProject(project.id, (p) => updateTrackModel(p, trackId, { voice }), `voice:${trackId}:${Object.keys(patch).join(',')}`);
    this.updateTrackVoice(trackId);
    if (this.isLive) this.syncMonitor();
  }

  /** Voice presets set the character and the track's pitch (e.g. Chipmunk: +7 st, formants up). */
  applyVoicePreset(trackId: string, id: VoicePresetId): void {
    const project = openProject(this.store.get());
    if (!project) return;
    const { voice, pitch } = withVoicePreset(id);
    this.mutateProject(project.id, (p) => updateTrackModel(p, trackId, { voice, pitch }));
    this.updateTrackVoice(trackId);
    this.refreshSongView();
    if (this.isLive) this.syncMonitor();
  }

  applyFxPreset(trackId: string, id: FxPresetId): void {
    const project = openProject(this.store.get());
    const track = project?.tracks.find((t) => t.id === trackId);
    if (!project || !track) return;
    const fx = withPreset(id);
    const tuning = FX_PRESETS[id].robot ? { ...track.tuning, enabled: true, retuneMs: 0 } : track.tuning;
    this.mutateProject(project.id, (p) => updateTrackModel(p, trackId, { fx, tuning }));
    this.player.setTrackFx(trackId, fx);
    if (tuning !== track.tuning && this.store.get().selectedTrackId === trackId) this.selectTrack(trackId); // reload inspector
    this.updateTrackVoice(trackId);
  }

  /** Per-track transpose in semitones (e.g. an octave-up double). */
  setTrackPitch(trackId: string, semitones: number): void {
    const project = openProject(this.store.get());
    if (!project) return;
    this.mutateProject(project.id, (p) => updateTrackModel(p, trackId, { pitch: semitones }), `pitch:${trackId}`);
    this.updateTrackVoice(trackId);
    this.refreshSongView();
  }

  /** Master key shift: transposes the instrumental (phase vocoder) and every vocal (PSOLA). */
  setKeyShift(semitones: number): void {
    const project = openProject(this.store.get());
    if (!project) return;
    this.mutateProject(project.id, (p) => ({ ...p, keyShift: semitones, updatedAt: Date.now() }), 'keyShift');
    if (this.isLive) this.syncMonitor();
    const updated = openProject(this.store.get())!;
    for (const t of updated.tracks) {
      if (t.kind === 'vocal') this.updateTrackVoice(t.id);
      else if (t.assetId) this.scheduleInstrumentalShift(t.id, t.assetId, semitones);
    }
    this.rebuildMix();
  }

  updateSongFx(patch: { reverb?: Partial<SongFx['reverb']>; echo?: Partial<SongFx['echo']> }): void {
    const project = openProject(this.store.get());
    if (!project) return;
    const cur = songFxOf(project);
    const fx: SongFx = { reverb: { ...cur.reverb, ...patch.reverb }, echo: { ...cur.echo, ...patch.echo } };
    this.mutateProject(project.id, (p) => ({ ...p, fx, updatedAt: Date.now() }), `songfx:${Object.keys(patch.reverb ?? patch.echo ?? {}).join(',')}`);
    this.player.setSongFx(fx, project.bpm ?? null);
  }

  /** The instrumental at the song's key shift (the original until the shifted render is ready). */
  private instrumentalBuffer(assetId: string, semitones: number): AudioBuffer | undefined {
    if (semitones === 0) return this.assets.get(assetId);
    return this.shiftedAssets.get(`${assetId}|${semitones}`) ?? this.assets.get(assetId);
  }

  private scheduleInstrumentalShift(trackId: string, assetId: string, semitones: number): void {
    const key = `${assetId}|${semitones}`;
    if (semitones === 0 || this.shiftedAssets.has(key)) return;
    this.debounce(`shift:${assetId}`, 300, async () => {
      const source = this.assets.get(assetId);
      if (!source) return;
      this.setTrackRender(trackId, { busy: true });
      try {
        const channels = Array.from({ length: source.numberOfChannels }, (_, c) => source.getChannelData(c));
        const shifted = await this.renderer.shiftInstrumental(channels, semitones);
        const buffer = this.player.context.createBuffer(shifted.length, shifted[0].length, source.sampleRate);
        shifted.forEach((ch, c) => buffer.copyToChannel(ch as Float32Array<ArrayBuffer>, c));
        this.shiftedAssets.set(key, buffer);
        // Only apply if the song still wants this shift.
        if (openProject(this.store.get())?.keyShift === semitones) this.rebuildMix();
      } catch (err) {
        this.store.set({ status: describeError(err) });
      } finally {
        this.setTrackRender(trackId, { busy: false });
      }
    });
  }

  undo(): void {
    this.restore((current) => this.history.undo(current));
  }

  redo(): void {
    this.restore((current) => this.history.redo(current));
  }

  private restore(step: (current: Project) => Project | null): void {
    const current = openProject(this.store.get());
    if (!current) return;
    const target = step(current);
    if (!target) return;
    const restored = { ...target, updatedAt: Date.now() };
    this.store.set((s) => ({ projects: s.projects.map((p) => (p.id === restored.id ? restored : p)) }));
    this.scheduleSave(restored);
    this.publishHistory();
    for (const id of [...this.voices.keys()]) if (!restored.tracks.some((t) => t.id === id)) this.dropVoice(id);
    // Reload the inspector (or pick another track if the selected one is gone), then the audio.
    const selected = this.store.get().selectedTrackId;
    const keep = restored.tracks.some((t) => t.id === selected && t.kind === 'vocal');
    this.selectTrack(keep ? selected : (restored.tracks.find((t) => t.kind === 'vocal')?.id ?? null));
    this.roll.setScaleHint(restored.key ?? null);
    this.run(async () => {
      for (const t of restored.tracks) {
        if (t.takeId) await this.loadTake(t.takeId);
        if (t.assetId) await this.loadAsset(t.assetId);
      }
      this.rebuildMix();
      for (const t of restored.tracks) {
        this.updateTrackVoice(t.id);
        if (t.kind === 'instrumental' && t.assetId) this.scheduleInstrumentalShift(t.id, t.assetId, restored.keyShift);
      }
    });
  }

  private publishHistory(): void {
    this.store.set({ history: { canUndo: this.history.canUndo, canRedo: this.history.canRedo } });
  }

  /**
   * Changes a song. For the open song the change is recorded for undo, unless `historyKey` is false;
   * edits with the same key in quick succession (a drag) become one undo step.
   */
  private mutateProject(id: string, fn: (p: Project) => Project, historyKey: string | null | false = null): void {
    const before = this.store.get().projects.find((p) => p.id === id);
    if (before && historyKey !== false && id === this.store.get().projectId) {
      this.history.push(before, historyKey);
      this.publishHistory();
    }
    let updated: Project | null = null;
    this.store.set((s) => ({
      projects: s.projects.map((p) => {
        if (p.id !== id) return p;
        updated = fn(p);
        return updated;
      }),
    }));
    if (updated) this.scheduleSave(updated);
  }

  private scheduleSave(project: Project): void {
    window.clearTimeout(this.saveTimers.get(project.id));
    this.saveTimers.set(
      project.id,
      window.setTimeout(() => {
        this.saveTimers.delete(project.id);
        const latest = this.store.get().projects.find((p) => p.id === project.id);
        if (latest) void this.getDb().then((db) => db.putProjects([latest]));
      }, SAVE_DELAY_MS),
    );
  }

  private flushSaves(): void {
    for (const [id, timer] of this.saveTimers) {
      window.clearTimeout(timer);
      const latest = this.store.get().projects.find((p) => p.id === id);
      if (latest) void this.getDb().then((db) => db.putProjects([latest]));
    }
    this.saveTimers.clear();
  }

  /** Re-draws the roll for the open song: the selected track in front, the others as ghosts. */
  private refreshSongView(): void {
    const state = this.store.get();
    const project = openProject(state);
    if (!project || this.isLive) return;
    // As heard: shifted by each track's offset and transposed by its pitch + the song's key shift.
    const shifted = (t: Track) => {
      const take = t.takeId ? this.takes.get(t.takeId) : undefined;
      const st = trackSemitones(t, project);
      return take ? take.frames.map((f) => ({ ...f, time: f.time + t.offset, midi: f.midi === null ? null : f.midi + st })) : [];
    };
    this.roll.setTuning(this.rollTuning());
    this.roll.setScaleHint(project.key ? transposeScale(project.key, project.keyShift) : null);
    const selected = project.tracks.find((t) => t.id === state.selectedTrackId);
    this.roll.setGhosts(project.tracks.filter((t) => t !== selected && t.kind === 'vocal').map((t) => ({ frames: shifted(t), hue: t.hue })));
    this.roll.showRecording(selected ? shifted(selected) : [], this.player.duration, this.player.currentTime);
  }

  // --- instrumentals --------------------------------------------------------------------------

  /**
   * Imports an audio file as the song's instrumental. With no song open (or `newSong`), a new song
   * named after the file is created. The original file is stored; key and tempo are detected in the
   * background and offered via `state.detection`.
   */
  importInstrumental(file: File, newSong = false): void {
    this.run(async () => {
      if (file.size > MAX_IMPORT_BYTES) throw new Error(`“${file.name}” is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB.`);
      if (!file.type.startsWith('audio/') && !file.type.startsWith('video/') && !IMPORT_EXTENSIONS.test(file.name)) {
        throw new Error(`“${file.name}” doesn’t look like an audio file.`);
      }
      if (this.isLive) await this.stopLive();
      this.store.set({ importing: true, status: '' });
      try {
        const data = await file.arrayBuffer();
        let buffer: AudioBuffer;
        try {
          buffer = await this.player.decode(data);
        } catch {
          throw new Error(`This browser can’t decode “${file.name}”. Try MP3 or WAV.`);
        }
        if (buffer.duration > MAX_IMPORT_SECONDS) throw new Error(`“${file.name}” is longer than ${MAX_IMPORT_SECONDS / 60} minutes.`);
        const asset: Asset = { id: newId(), name: titleFromFileName(file.name), type: file.type, createdAt: Date.now(), data };
        const db = await this.getDb();
        await db.putAsset(asset);
        this.assets.set(asset.id, buffer);

        if (newSong || !this.store.get().projectId) {
          const project = { ...createProject(asset.name) };
          await db.putProjects([project]);
          this.store.set((s) => ({ projects: [project, ...s.projects] }));
          await this.openProjectNow(project.id);
        }
        const project = openProject(this.store.get())!;
        this.mutateProject(project.id, (p) => withInstrumental(p, createInstrumentalTrack(asset)));
        this.rebuildMix();
        this.player.seek(0);

        // Key + tempo, in the worker. The tempo is kept (count-in); the key is offered to the user.
        const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
        const analysis = await this.renderer.analyze(downmix(channels), buffer.sampleRate);
        const bpm = analysis.tempo && analysis.tempo.confidence > 1.3 ? Math.round(analysis.tempo.bpm) : null;
        const key = analysis.key && analysis.key.confidence > 0.5 ? analysis.key.scale : null;
        if (bpm) this.mutateProject(project.id, (p) => ({ ...p, bpm, updatedAt: Date.now() }), false);
        if (this.store.get().projectId === project.id) this.store.set({ detection: { projectId: project.id, key, bpm } });
      } finally {
        this.store.set({ importing: false });
      }
    });
  }

  /** Accept the detected key: every vocal track (and new tracks) auto-tunes in it. */
  applyDetectedKey(): void {
    const { detection, projectId } = this.store.get();
    if (!detection?.key || detection.projectId !== projectId) return;
    this.setSongKey(detection.key);
    this.store.set({ detection: null });
  }

  dismissDetection(): void {
    this.store.set({ detection: null });
  }

  setSongKey(key: Scale): void {
    const project = openProject(this.store.get());
    if (!project) return;
    this.mutateProject(project.id, (p) => applyKey(p, key));
    if (this.stash) this.stash = { ...this.stash, tuning: { ...this.stash.tuning, enabled: true, root: key.root, type: key.type } };
    this.roll.setScaleHint(key);
    this.selectTrack(this.store.get().selectedTrackId); // reload the inspector with the new key
    for (const t of openProject(this.store.get())!.tracks) this.updateTrackVoice(t.id);
  }

  private async loadAsset(id: string): Promise<AudioBuffer> {
    const cached = this.assets.get(id);
    if (cached) return cached;
    const asset = await (await this.getDb()).getAsset(id);
    if (!asset) throw new Error('The instrumental file is missing.');
    const buffer = await this.player.decode(asset.data);
    this.assets.set(id, buffer);
    return buffer;
  }

  // --- latency calibration ----------------------------------------------------------------------

  /**
   * Loopback calibration: plays clicks through the speakers and listens with the mic, measuring the
   * true round trip. Needs speakers (not headphones). Stores the result in the input prefs.
   */
  calibrateLatency(): void {
    this.run(async () => {
      if (this.isLive) await this.stopLive();
      this.player.pause();
      this.store.set({ calibrating: true, status: '' });
      const blocks: { samples: Float32Array; time: number }[] = [];
      try {
        this.blockSink = (samples, time) => blocks.push({ samples, time });
        await this.input.start('mic', { noiseSuppression: false });
        const ctx = sharedContext();
        const first = ctx.currentTime + 0.6;
        const clicks = Array.from({ length: 6 }, (_, i) => first + i * 0.45);
        scheduleClicks(ctx, clicks, { level: 0.9, accentFirst: false });
        await new Promise((r) => setTimeout(r, (clicks[clicks.length - 1] - ctx.currentTime + 0.7) * 1000));
        await this.input.stop();
        if (!blocks.length) throw new Error('No sound came in from the microphone.');
        const all = new SampleBuffer();
        for (const b of blocks) all.push(b.samples);
        const latency = detectClickLatency(all.toFloat32(), blocks[0].time, ctx.sampleRate, clicks);
        if (latency === null) {
          this.store.set({ status: 'Couldn’t hear the clicks. Use speakers (not headphones), turn the volume up, and try again.' });
        } else {
          this.store.set((s) => ({ input: { ...s.input, calibratedMs: Math.round(latency * 1000) } }));
        }
      } finally {
        this.blockSink = null;
        this.store.set({ calibrating: false });
      }
    });
  }

  // --- playback -------------------------------------------------------------------------------

  togglePlay(): void {
    if (!this.preview && !this.store.get().projectId) return;
    if (this.player.playing) this.player.pause();
    else void this.player.play();
  }

  seek(time: number): void {
    this.player.seek(time);
    this.roll.setTime(this.player.currentTime);
  }

  setListenProcessed(on: boolean): void {
    this.store.set({ listenProcessed: on });
    if (this.store.get().projectId) this.rebuildMix();
    else this.updatePreviewSource();
  }

  /**
   * Called when the inspector settings change. Preview: re-render the take. Song: write them to the
   * selected track (if any), then re-render that track.
   */
  settingsChanged(): void {
    const state = this.store.get();
    this.roll.setTuning(this.rollTuning());
    if (this.isLive) this.syncMonitor();
    if (!state.projectId) {
      this.schedulePreviewRender();
      return;
    }
    const track = openProject(state)?.tracks.find((t) => t.id === state.selectedTrackId);
    if (!track) {
      // No track selected: the inspector is editing the global defaults for new tracks.
      if (this.stash) this.stash = { tuning: state.tuning, cleanup: state.cleanup };
      return;
    }
    const cleanup = { denoise: state.cleanup.denoise, denoiseDb: state.cleanup.denoiseDb };
    if (JSON.stringify(track.tuning) === JSON.stringify(state.tuning) && JSON.stringify(track.cleanup) === JSON.stringify(cleanup)) {
      return; // just loaded into the inspector by selectTrack
    }
    this.mutateProject(state.projectId, (p) => updateTrackModel(p, track.id, { tuning: state.tuning, cleanup }), `settings:${track.id}`);
    this.updateTrackVoice(track.id);
  }

  /** The global defaults while a song is open (for saving prefs); the inspector settings otherwise. */
  globalSettings(): { tuning: TuningPrefs; cleanup: CleanupPrefs } {
    const { tuning, cleanup } = this.store.get();
    return this.stash ? { tuning: this.stash.tuning, cleanup: { ...this.stash.cleanup, micFilter: cleanup.micFilter } } : { tuning, cleanup };
  }

  // --- voice engine: cleaned source + grain plans (Phase 13) -----------------------------------
  //
  // Each take that plays (the preview, or each vocal track of the song) has a Voice: the cleaned
  // source audio from the worker (redone only when clean-up settings change) and the grain plans for
  // the current tuning (redone on every change, in the worker, in milliseconds). Plans go straight
  // to the playing engine node, so knob changes are heard on the next audio block.

  /**
   * Brings a voice up to date with `settings` (re-read when the request is sent). Clean-up changes
   * wait 120 ms (a slider being dragged), plan-only changes go out right away; the worker merges any
   * that pile up. `onUpdate(sourceChanged)` runs when new source/plans arrive.
   */
  private updateVoice(
    channel: string,
    voice: Voice,
    take: LoadedTake,
    settingsOf: () => ProcessSettings | null,
    isCurrent: () => boolean,
    setRender: (patch: Partial<RenderState>) => void,
    onUpdate: (sourceChanged: boolean) => void,
  ): void {
    const rate = this.player.context.sampleRate;
    const prepareKey = (s: ProcessSettings) =>
      JSON.stringify([take.meta.id, s.denoise, s.gate ?? 0, s.deess ?? 0, rate]);
    const first = settingsOf();
    if (!first) {
      this.cancelRender(channel);
      const had = voice.source !== null || voice.plans !== null;
      voice.source = null;
      voice.plans = null;
      setRender({ busy: false, ready: false, notes: [] });
      if (had) onUpdate(true);
      return;
    }
    const needsPrepare = prepareKey(first) !== voice.sentKey;
    if (needsPrepare) setRender({ busy: true });
    this.debounce(channel, needsPrepare ? 120 : 0, async () => {
      const settings = settingsOf();
      if (!settings || !isCurrent()) return;
      const key = prepareKey(settings);
      const prepare =
        key !== voice.sentKey
          ? { key, recordingId: take.meta.id, samples: take.samples, sampleRate: take.meta.sampleRate, targetRate: rate, frames: take.frames, settings }
          : undefined;
      voice.sentKey = key;
      try {
        const r = await this.renderer.voice(channel, { prepare, tune: settings.tune, semitones: settings.pitch ?? 0, voice: settings.voice, have: voice.version });
        if (!r || !isCurrent()) return; // superseded, removed or closed
        if (r.source) {
          voice.source = r.source;
          voice.version = r.version;
        }
        voice.plans = r.plans;
        setRender({ ready: true, notes: r.notes });
        onUpdate(!!r.source);
      } catch (err) {
        console.error(err);
        voice.sentKey = null; // try again from scratch next time
        this.store.set({ status: describeError(err) });
      } finally {
        if (isCurrent() && !this.renderer.busy(channel)) setRender({ busy: false });
      }
    });
  }

  // --- take preview -----------------------------------------------------------------------------

  private schedulePreviewRender(): void {
    const rec = this.preview;
    if (!rec) return;
    this.updateVoice(
      PREVIEW_CHANNEL,
      rec.voice,
      rec,
      () => {
        const { tuning, cleanup } = this.store.get();
        return processSettingsOf(tuning, cleanup);
      },
      () => this.preview === rec,
      (patch) => this.setPreviewRender(patch),
      () => {
        this.updatePreviewSource();
        if (this.playWhenProcessed) {
          this.playWhenProcessed = false;
          void this.player.play();
        }
      },
    );
    if (!processSettingsOf(this.store.get().tuning, this.store.get().cleanup)) this.updatePreviewSource();
  }

  private setPreviewRender(patch: Partial<RenderState>): void {
    this.store.set((s) => ({ render: { ...s.render, ...patch } }));
  }

  /** Points the player at the processed or original take, keeping position and play state. */
  private updatePreviewSource(): void {
    const rec = this.preview;
    if (!rec) return;
    const v = rec.voice;
    if (wantsProcessed(this.store.get()) && v.source) this.player.swap(v.source, this.player.context.sampleRate, v.plans);
    else this.player.swap(rec.samples, rec.meta.sampleRate, null);
  }

  // --- song tracks ------------------------------------------------------------------------------

  /** Updates a vocal track's voice (cleaned source + plans) after any change to its settings. */
  private updateTrackVoice(trackId: string): void {
    const project = openProject(this.store.get());
    const track = project?.tracks.find((t) => t.id === trackId && t.kind === 'vocal');
    const take = track?.takeId ? this.takes.get(track.takeId) : undefined;
    if (!project || !track || !take) return;
    const voice = this.voices.get(trackId) ?? newVoice();
    this.voices.set(trackId, voice);
    this.updateVoice(
      trackId,
      voice,
      take,
      () => {
        const p = openProject(this.store.get());
        const t = p?.tracks.find((x) => x.id === trackId);
        return p && t ? trackProcessSettings(t, p) : null;
      },
      () => this.voices.get(trackId) === voice,
      (patch) => this.setTrackRender(trackId, patch),
      (sourceChanged) => {
        if (sourceChanged) this.rebuildMix();
        else this.player.setPlans(trackId, this.store.get().listenProcessed ? voice.plans : null);
      },
    );
  }

  private setTrackRender(trackId: string, patch: Partial<RenderState>): void {
    this.store.set((s) => ({
      trackRender: { ...s.trackRender, [trackId]: { ...(s.trackRender[trackId] ?? { busy: false, ready: false, notes: [] }), ...patch } },
    }));
  }

  /** What each track plays right now: the cleaned source + plans when wanted and ready, else the take. */
  private mixSpecs(project: Project): MixTrackSpec[] {
    const listen = this.store.get().listenProcessed;
    const rate = this.player.context.sampleRate;
    const specs: MixTrackSpec[] = [];
    for (const t of project.tracks) {
      if (t.kind === 'instrumental') {
        const buffer = t.assetId ? this.instrumentalBuffer(t.assetId, project.keyShift) : undefined;
        if (buffer) {
          specs.push({ id: t.id, samples: EMPTY, sampleRate: buffer.sampleRate, buffer, gain: effectiveGain(t, project.tracks), pan: t.pan, offset: t.offset });
        }
        continue;
      }
      const take = t.takeId ? this.takes.get(t.takeId) : undefined;
      if (!take) continue;
      const voice = this.voices.get(t.id);
      const processed = listen && trackProcessSettings(t, project) !== null && voice?.source ? voice : null;
      specs.push({
        id: t.id,
        samples: processed ? processed.source! : take.samples,
        sampleRate: processed ? rate : take.meta.sampleRate,
        plans: processed ? processed.plans : null,
        gain: effectiveGain(t, project.tracks),
        pan: t.pan,
        offset: t.offset,
        fx: trackFxOf(t),
      });
    }
    return specs;
  }

  private rebuildMix(): void {
    const project = openProject(this.store.get());
    if (!project) return;
    this.player.setMaster(masterOf(project));
    this.player.setSongFx(songFxOf(project), project.bpm ?? null);
    this.player.setTracks(this.mixSpecs(project));
    this.syncLoop();
    this.store.set({ duration: this.player.duration });
    this.refreshSongView();
  }

  // --- render plumbing ------------------------------------------------------------------------

  private debounce(channel: string, delay: number, fn: () => void): void {
    window.clearTimeout(this.renderTimers.get(channel));
    this.renderTimers.set(
      channel,
      window.setTimeout(() => {
        this.renderTimers.delete(channel);
        fn();
      }, delay),
    );
  }

  /** Forgets a track's voice (removed track, closed song), here and in the worker. */
  private dropVoice(trackId: string): void {
    this.cancelRender(trackId);
    this.voices.delete(trackId);
    this.renderer.dropVoice(trackId);
  }

  private cancelRender(channel?: string): void {
    if (channel !== undefined) {
      window.clearTimeout(this.renderTimers.get(channel));
      this.renderTimers.delete(channel);
    }
    this.renderer.cancel(channel);
  }
}

/** Placeholder `samples` for buffer-backed (instrumental) mix specs. */
const EMPTY = new Float32Array(0);

function nextRecordingName(recordings: readonly RecordingMeta[]): string {
  const used = recordings.map((r) => /^Recording (\d+)$/.exec(r.name)?.[1]).filter(Boolean).map(Number);
  return `Recording ${Math.max(0, ...used) + 1}`;
}

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_');
}

export function downloadBlob(blob: Blob, name: string, ext = 'wav'): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeName(name)}.${ext}`;
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
