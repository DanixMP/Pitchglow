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
import { alignTake, detectClickLatency } from '../audio/sync';
import { downmix } from '../dsp/analyze';
import type { Scale } from '../dsp/scales';
import { MixPlayer, type MixTrackSpec } from '../audio/mix-player';
import { exportLength, renderMix, renderStems, renderVoice } from '../audio/mixdown';
import { cleanupNotes, cleanupSettingsOf, type ProcessSettings } from '../dsp/process';
import { CLEANUP_OFF, type CleanupAnalysis } from '../dsp/cleanup';
import type { VoicePlans } from '../dsp/voice-engine';
import { addKeyEvent, keysAt, type KeyEvent, type Voicing } from '../dsp/keys';
import { MidiInput } from '../audio/midi-input';
import { buildWarp, isNeutralEdit, noteSpan, segmentNotes, warpToOutput, type NoteEdit, type SungNote } from '../dsp/note-edit';
import {
  alignToBeat,
  clampBpm,
  clickGridOf,
  countInLead,
  gridOf,
  normalizeDownbeat,
  snapToGrid,
  TAP_RESET_SECONDS,
  takeOnset,
  tapTempo,
} from '../project/grid';
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
  dbToGain,
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
  type TrackKeys,
  updateTrack as updateTrackModel,
  withInstrumental,
  withoutTake,
  type Project,
  type Track,
} from '../project/model';
import { packFrames, unpackFrames } from '../storage/pitch-track';
import { RecordingStore, type Asset, type RecordingMeta } from '../storage/recording-store';
import type { CleanupPrefs, KeysPrefs, TuningPrefs } from '../storage/settings';
import type { PianoRoll } from '../ui/piano-roll';
import { processedLabelOf, processSettingsOf, trackProcessSettings, tuneSettingsOf, wantsProcessed } from './processing';
import { openProject, type AppStore, type RenderState } from './state';

const MIN_RECORDING_SECONDS = 0.3;
/** Imported instrumentals: limits that keep memory sane on phones. */
const MAX_IMPORT_BYTES = 80 * 1024 * 1024;
const MAX_IMPORT_SECONDS = 15 * 60;
const IMPORT_EXTENSIONS = /\.(mp3|wav|wave|m4a|aac|mp4|ogg|oga|opus|flac|webm)$/i;
const PREVIEW_CHANNEL = 'preview';
const SAVE_DELAY_MS = 400;

interface LoadedTake {
  meta: RecordingMeta;
  samples: Float32Array;
  frames: PitchFrame[];
}

/** A take's voice-engine input: the cleaned source (worker) and the grain plans for its settings. */
interface Voice {
  /** The take at the playback rate (the take itself when no resampling was needed); null = not prepared. */
  source: Float32Array | null;
  /** Noise profile + gate map for the live clean-up (null = not prepared). */
  cleanup: CleanupAnalysis | null;
  /** Worker version of the preparation. */
  version: number;
  /** Preparation key (take + rate) last sent to the worker. */
  sentKey: string | null;
  plans: VoicePlans | null;
}

const newVoice = (): Voice => ({ source: null, cleanup: null, version: 0, sentKey: null, plans: null });

/** Settings with nothing switched on (used to prepare a take ahead of time). */
const NOTHING: ProcessSettings = { denoise: null, tune: null };

/** What a voice update changed: the preparation (new audio), the plans, or only clean-up settings. */
type VoiceChange = 'prepared' | 'plans' | 'cleanup';

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
  private take: { audio: SampleBuffer; frames: PitchFrame[]; firstTime: number | null; keys: KeyEvent[] } | null = null;
  /** Recording over the song: when/where playback started, for aligning the take afterwards. */
  private sync: { playStart: number; songPosition: number; latency: number } | null = null;
  /** Calibration listens to raw blocks instead of the tracker. */
  private blockSink: ((block: Float32Array, time: number) => void) | null = null;
  /** Decoded instrumentals by asset id. */
  private assets = new Map<string, AudioBuffer>();

  /** Take preview (no song open). */
  private preview: (LoadedTake & { voice: Voice }) | null = null;
  /** Loaded takes (audio + pitch) for the open song, by take id. */
  private takes = new Map<string, LoadedTake>();
  /** Voice-engine inputs for the open song's vocal tracks, by track id. */
  private voices = new Map<string, Voice>();
  private renderTimers = new Map<string, number>();
  /** Global settings, stashed while a song's track settings occupy the inspector. */
  private stash: { tuning: TuningPrefs; cleanup: CleanupPrefs } | null = null;
  /** Tap-tempo taps (seconds, performance clock). */
  private taps: number[] = [];
  /** Play-the-keys: keys down (screen or MIDI), keys kept by the sustain pedal, the pedal. */
  private keysDown = new Set<number>();
  private sustained = new Set<number>();
  private sustain = false;
  private readonly midi = new MidiInput({
    onNote: (midi, down) => this.keyPress(midi, down, 'midi'),
    onSustain: (down) => this.setSustain(down),
    onDevices: (devices) => this.store.set({ midi: { devices, status: 'on' } }),
  });
  /** Sung notes per take (segmented once), and the note being dragged on the roll. */
  private takeNotes = new Map<string, SungNote[]>();
  private noteDragBase: { trackId: string; index: number; edit: NoteEdit; span: { start: number; end: number }; key: string } | null = null;
  private noteDrags = 0;
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
    this.syncKeys();
    if (this.store.get().keys.on) void this.startMidi();
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
    // Keys already held when the take starts are part of it from its first sample.
    const held = this.store.get().keys.on ? this.store.get().heldKeys : [];
    this.take = record ? { audio: new SampleBuffer(), frames: [], firstTime: null, keys: addKeyEvent([], 0, held) } : null;
    this.roll.start();
    this.roll.setNotes(null, null);
    this.roll.setKeyHarmony(null);
    this.store.set({ mode: record ? 'recording' : 'listening', recordingSeconds: 0, status: '' });
    this.syncMonitor();
    this.syncKeys();
    const song = openProject(this.store.get());
    this.roll.setGrid(null);
    const { metronome, input } = this.store.get();
    // Something to sing along to: the song, the click, or at least a count-in.
    if (record && song && (this.songIsAudible(song) || metronome.on || input.countIn)) await this.playAlong(song);
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
    // The count-in clicks on the grid's beats in the bar before the position (the click worklet).
    const grid = clickGridOf(song);
    const countIn = input.countIn ? countInLead(position, grid) : 0;
    const playStart = await this.player.play(ctx.currentTime + 0.12 + countIn, { countIn, recording: true });
    // Round trip (calibrated, or the browser's estimate), plus the mix chain's own delay: you sing
    // along to the song as you hear it.
    const roundTrip = input.calibratedMs !== null ? input.calibratedMs / 1000 : outputLatency(ctx) + this.input.inputLatency;
    const latency = roundTrip + this.player.mixLatency;
    this.sync = { playStart, songPosition: position, latency };
    // Other tracks as ghosts on the live roll, lined up with what you hear.
    const toLive = position - (playStart - this.liveOrigin) - outputLatency(ctx) - this.player.mixLatency;
    this.roll.setGrid(gridOf(song), toLive);
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

  private async saveTake(t: { audio: SampleBuffer; frames: PitchFrame[]; keys?: KeyEvent[] }, offset = 0): Promise<void> {
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
      const { tuning, cleanup, keys } = this.store.get();
      // Keys played while singing come along, so the track plays the same harmony back.
      const played = keys.on && t.keys?.length ? { events: t.keys, voicing: keys.voicing } : undefined;
      this.addTrackFromTake(meta, tuning, cleanup, offset, true, played);
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
    this.roll.setGrid(null);
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
      const settings = processSettingsOf(state.tuning, state.cleanup);
      const cleanupSettings = settings ? cleanupSettingsOf(settings) : CLEANUP_OFF;
      this.run(async () => this.download([await renderVoice(voice.source!, rate, voice.plans, voice.cleanup, cleanupSettings)], rate, `${meta.name} (${label})`));
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
    for (const t of project.tracks) this.updateTrackVoice(t.id);
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
    this.roll.setGrid(null);
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
      noteMode: false,
      selectedNote: null,
      ...(stash ? { tuning: stash.tuning, cleanup: { ...stash.cleanup, micFilter: this.store.get().cleanup.micFilter } } : {}),
    });

    this.syncMetronome();
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
  private addTrackFromTake(meta: RecordingMeta, tuning: TuningPrefs, cleanup: CleanupPrefs, offset = 0, sung = false, keys?: TrackKeys): void {
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
      ...(keys ? { keys } : {}),
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
      ...(track?.id !== state.selectedTrackId ? { selectedNote: null } : {}),
      ...(track ? {} : { noteMode: false }),
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
    const region = normalizeLoop(start, end, gridOf(project), this.player.duration, true);
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
      const region = defaultLoop(this.player.currentTime, gridOf(project), this.player.duration);
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

  /**
   * Master key shift, live: the instrumental through the streaming phase vocoder (beat engine) and
   * every vocal through new plans (PSOLA). Nothing is re-rendered and playback doesn't stop.
   */
  setKeyShift(semitones: number): void {
    const project = openProject(this.store.get());
    if (!project) return;
    this.mutateProject(project.id, (p) => ({ ...p, keyShift: semitones, updatedAt: Date.now() }), 'keyShift');
    if (this.isLive) this.syncMonitor();
    const updated = openProject(this.store.get())!;
    for (const t of updated.tracks) {
      if (t.kind === 'vocal') this.updateTrackVoice(t.id);
      else this.player.setShift(t.id, semitones);
    }
    this.refreshSongView();
  }

  updateSongFx(patch: { reverb?: Partial<SongFx['reverb']>; echo?: Partial<SongFx['echo']> }): void {
    const project = openProject(this.store.get());
    if (!project) return;
    const cur = songFxOf(project);
    const fx: SongFx = { reverb: { ...cur.reverb, ...patch.reverb }, echo: { ...cur.echo, ...patch.echo } };
    this.mutateProject(project.id, (p) => ({ ...p, fx, updatedAt: Date.now() }), `songfx:${Object.keys(patch.reverb ?? patch.echo ?? {}).join(',')}`);
    this.player.setSongFx(fx, project.bpm ?? null);
  }

  // --- play-the-keys harmony (Phase 19) -------------------------------------------------------------

  /** Keys mode on/off (harmony from held keys). Starts listening to MIDI keyboards the first time. */
  setKeysOn(on: boolean): void {
    this.store.set((s) => ({ keys: { ...s.keys, on } }));
    if (on) void this.startMidi();
    else this.releaseAllKeys();
    this.syncKeys();
  }

  setKeysPrefs(patch: Partial<Pick<KeysPrefs, 'latch' | 'voicing'>>): void {
    this.store.set((s) => ({ keys: { ...s.keys, ...patch } }));
    if (patch.latch === false) this.releaseAllKeys();
    this.syncKeys();
  }

  private async startMidi(): Promise<void> {
    if (!MidiInput.supported) return this.store.set({ midi: { devices: [], status: 'unsupported' } });
    const ok = await this.midi.start();
    if (!ok) this.store.set({ midi: { devices: [], status: 'denied' } });
  }

  /**
   * A key pressed or released: on the roll's keyboard (`screen`; with latch a press toggles it) or a
   * MIDI keyboard (held while down, or until the sustain pedal comes up).
   */
  keyPress(midi: number, down: boolean, source: 'screen' | 'midi'): void {
    if (!this.store.get().keys.on) return;
    if (source === 'screen' && this.store.get().keys.latch) {
      if (!down) return;
      if (this.keysDown.has(midi)) this.keysDown.delete(midi);
      else this.keysDown.add(midi);
    } else if (down) {
      this.keysDown.add(midi);
      this.sustained.delete(midi);
    } else {
      this.keysDown.delete(midi);
      if (this.sustain) this.sustained.add(midi);
    }
    this.syncKeys();
  }

  private setSustain(down: boolean): void {
    this.sustain = down;
    if (!down) this.sustained.clear();
    this.syncKeys();
  }

  /** Lets go of every key (latched, held and sustained). */
  releaseAllKeys(): void {
    this.keysDown.clear();
    this.sustained.clear();
    this.syncKeys();
  }

  /** Sends the held keys to the live voice and the roll, and records changes into a take. */
  syncKeys(): void {
    const { keys, tuning } = this.store.get();
    const held = keys.on ? [...new Set([...this.keysDown, ...this.sustained])].sort((a, b) => a - b) : [];
    const prev = this.store.get().heldKeys;
    if (held.length !== prev.length || held.some((n, i) => n !== prev[i])) this.store.set({ heldKeys: held });
    this.input.setKeys(keys.on ? held : null, keys.voicing, tuning.harmonyMix);
    this.roll.setKeysPlayable(keys.on);
    this.roll.setHeldKeys(held);
    // Live: the line's harmony follows the held keys.
    if (this.isLive) this.roll.setKeyHarmony(keys.on ? { voicing: keys.voicing, held } : null);
    const take = this.take;
    if (take && keys.on) {
      const t = take.firstTime === null ? 0 : this.player.context.currentTime - take.firstTime;
      take.keys = addKeyEvent(take.keys, t, held);
    }
  }

  /** Removes the keys recorded with a track (its harmony goes back to the interval voices). */
  clearTrackKeys(trackId: string): void {
    const project = openProject(this.store.get());
    if (!project?.tracks.find((t) => t.id === trackId)?.keys) return;
    this.mutateProject(project.id, (p) => updateTrackModel(p, trackId, { keys: undefined }));
    this.updateTrackVoice(trackId);
  }

  /** Voicing of the keys recorded with a track (re-plans its harmony). Undoable. */
  setTrackKeysVoicing(trackId: string, voicing: Voicing): void {
    const project = openProject(this.store.get());
    const track = project?.tracks.find((t) => t.id === trackId);
    if (!project || !track?.keys) return;
    this.mutateProject(project.id, (p) => updateTrackModel(p, trackId, { keys: { ...track.keys!, voicing } }));
    this.updateTrackVoice(trackId);
  }

  // --- tempo & metronome (Phase 17) -------------------------------------------------------------

  /**
   * Tempo, beats per bar, bar 1. Undoable; the click, echo timing, grid lines and snapping follow.
   * A BPM of null removes the grid.
   */
  setTempo(patch: { bpm?: number | null; beatsPerBar?: number; downbeat?: number }): void {
    const project = openProject(this.store.get());
    if (!project) return;
    const field = Object.keys(patch)[0];
    this.mutateProject(
      project.id,
      (p) => {
        const next = { ...p, ...patch, updatedAt: Date.now() };
        if (next.bpm) next.bpm = clampBpm(next.bpm);
        const g = gridOf(next);
        // Keep bar 1 inside the first bar (a slower tempo or fewer beats make bars shorter).
        if (g) next.downbeat = normalizeDownbeat(g.downbeat, g);
        return next;
      },
      `tempo:${field}`,
    );
    this.tempoChanged();
  }

  /** One tap of the Tap button: the tempo follows the taps (one undo step per run of taps). */
  tapTempo(): void {
    const now = performance.now() / 1000;
    const last = this.taps[this.taps.length - 1];
    if (last !== undefined && now - last > TAP_RESET_SECONDS) this.taps = [];
    this.taps.push(now);
    const bpm = tapTempo(this.taps);
    if (bpm) this.setTempo({ bpm });
  }

  /** Bar 1 starts at the playhead (sets a tempo first if the song has none). */
  setDownbeatHere(): void {
    const project = openProject(this.store.get());
    if (!project) return;
    const grid = gridOf(project) ?? clickGridOf(null);
    this.setTempo({ bpm: grid.bpm, downbeat: normalizeDownbeat(this.player.currentTime, grid) });
  }

  /** Moves a vocal track so the singing starts on the nearest beat (Q). */
  alignTrackToBeat(trackId: string): void {
    const project = openProject(this.store.get());
    const track = project?.tracks.find((t) => t.id === trackId);
    if (!project || !track?.takeId) return;
    const grid = gridOf(project);
    if (!grid) return this.store.set({ status: 'Set the song’s tempo first (Tempo section).' });
    const take = this.takes.get(track.takeId);
    const onset = take ? takeOnset(take.frames) : null;
    if (onset === null) return this.store.set({ status: 'No singing found in this take.' });
    const offset = alignToBeat(track.offset, onset, grid);
    if (offset !== track.offset) this.updateTrackMix(trackId, { offset });
    this.store.set({ status: '' });
  }

  /** Points the click at the current prefs and the open song's grid (no song: silent). */
  syncMetronome(): void {
    const state = this.store.get();
    const song = openProject(state);
    const { on, levelDb, accent } = state.metronome;
    this.player.setMetronome({ on: on && !!song, gain: dbToGain(levelDb), accent, grid: clickGridOf(song) });
  }

  private tempoChanged(): void {
    const project = openProject(this.store.get());
    if (!project) return;
    this.player.setSongFx(songFxOf(project), project.bpm ?? null);
    this.syncMetronome();
    this.syncLoop();
    this.refreshSongView();
  }

  // --- note editing (Phase 18) ------------------------------------------------------------------

  /** The selected vocal track and its take, when there is one to edit. */
  private editTarget(): { project: Project; track: Track; take: LoadedTake; notes: SungNote[] } | null {
    const state = this.store.get();
    const project = openProject(state);
    const track = project?.tracks.find((t) => t.id === state.selectedTrackId && t.kind === 'vocal');
    const take = track?.takeId ? this.takes.get(track.takeId) : undefined;
    if (!project || !track || !take) return null;
    return { project, track, take, notes: this.notesOf(take) };
  }

  /** The sung notes of a take (segmented once). */
  notesOf(take: { meta: RecordingMeta; frames: PitchFrame[] }): SungNote[] {
    let notes = this.takeNotes.get(take.meta.id);
    if (!notes) {
      notes = segmentNotes(take.frames);
      this.takeNotes.set(take.meta.id, notes);
    }
    return notes;
  }

  /** Take time (s) as sung -> as heard, after the track's note timing edits. */
  private takeTimeMap(track: Track, take: LoadedTake): (t: number) => number {
    const edits = track.noteEdits ?? [];
    if (!edits.some((e) => e.start !== undefined)) return (t) => t;
    // In milliseconds, so the warp's 1-unit margins are 1 ms.
    const warp = buildWarp(this.notesOf(take), edits, 1000, take.meta.duration * 1000);
    return warp ? (t) => warpToOutput(warp, t * 1000) / 1000 : (t) => t;
  }

  /** Note editing on the roll on/off (N). Needs a vocal track selected in an open song. */
  toggleNoteMode(on = !this.store.get().noteMode): void {
    if (on && !this.editTarget()) {
      this.store.set({ status: 'Select a vocal track to edit its notes.' });
      return;
    }
    this.store.set({ noteMode: on, ...(on ? {} : { selectedNote: null }), status: '' });
    this.syncNoteBlobs();
  }

  selectNote(index: number | null): void {
    const target = this.editTarget();
    if (index !== null && (!target || index < 0 || index >= target.notes.length)) return;
    this.store.set({ selectedNote: index });
    this.syncNoteBlobs();
  }

  /** Selects the next (+1) or previous (−1) note; the first one when none is selected. */
  stepNote(dir: 1 | -1): void {
    const target = this.editTarget();
    if (!target?.notes.length) return;
    const cur = this.store.get().selectedNote;
    const next = cur === null ? (dir > 0 ? 0 : target.notes.length - 1) : Math.min(target.notes.length - 1, Math.max(0, cur + dir));
    this.selectNote(next);
    // Bring it into view: put the playhead at its start.
    const n = target.notes[next];
    const span = noteSpan(n, this.noteEdit(target.track, n));
    if (!this.player.playing) this.seek(span.start + target.track.offset);
  }

  /** The edit stored for a note (if any). */
  private noteEdit(track: Track, note: SungNote): NoteEdit | undefined {
    return track.noteEdits?.find((e) => e.from === note.from && e.to === note.to);
  }

  /** Current edit of a note (neutral when it has none). */
  noteEditOf(index: number): { note: SungNote; edit: NoteEdit } | null {
    const target = this.editTarget();
    const note = target?.notes[index];
    if (!target || !note) return null;
    return { note, edit: this.noteEdit(target.track, note) ?? { from: note.from, to: note.to, shift: 0, amount: null } };
  }

  /** Changes one note's edit (pitch, amount, timing). Undoable; drags coalesce under `historyKey`. */
  editNote(index: number, patch: Partial<Omit<NoteEdit, 'from' | 'to'>>, historyKey: string | null = null, windowMs?: number): void {
    const target = this.editTarget();
    const cur = this.noteEditOf(index);
    if (!target || !cur) return;
    const next: NoteEdit = { ...cur.edit, ...patch };
    if (next.start === undefined || next.end === undefined) {
      delete next.start;
      delete next.end;
    }
    const others = (target.track.noteEdits ?? []).filter((e) => !(e.from === next.from && e.to === next.to));
    const noteEdits = isNeutralEdit(next) ? others : [...others, next].sort((a, b) => a.from - b.from);
    this.mutateProject(target.project.id, (p) => updateTrackModel(p, target.track.id, { noteEdits }), historyKey, windowMs);
    this.updateTrackVoice(target.track.id);
    this.refreshSongView();
  }

  resetNote(index: number): void {
    this.editNote(index, { shift: 0, amount: null, start: undefined, end: undefined });
  }

  /** Removes every note edit of the selected track. */
  resetAllNotes(): void {
    const target = this.editTarget();
    if (!target?.track.noteEdits?.length) return;
    this.mutateProject(target.project.id, (p) => updateTrackModel(p, target.track.id, { noteEdits: [] }));
    this.updateTrackVoice(target.track.id);
    this.refreshSongView();
  }

  /**
   * A note dragged on the roll: up/down moves its pitch (whole semitones; free with Alt), sideways
   * moves it in time (snapped to 1/16 of the song's grid; free with Alt), its ends stretch it. It
   * stays between its neighbours (which give way down to 50 ms). One undo step per drag.
   */
  dragNote(drag: { index: number; kind: 'move' | 'start' | 'end'; semitones: number; seconds: number; free: boolean; done: boolean }): void {
    const target = this.editTarget();
    const cur = this.noteEditOf(drag.index);
    if (!target || !cur) return;
    if (!this.noteDragBase || this.noteDragBase.index !== drag.index || this.noteDragBase.trackId !== target.track.id) {
      // One undo step per drag, however long it takes.
      this.noteDragBase = { trackId: target.track.id, index: drag.index, edit: cur.edit, span: noteSpan(cur.note, cur.edit), key: `notedrag:${++this.noteDrags}` };
    }
    const base = this.noteDragBase;
    const key = base.key;
    if (drag.semitones) {
      const shift = drag.free ? Math.round((base.edit.shift + drag.semitones) * 100) / 100 : Math.round(base.edit.shift + drag.semitones);
      if (shift !== cur.edit.shift) this.editNote(drag.index, { shift }, key, Infinity);
    } else if (drag.seconds) {
      const { notes, track, take, project } = target;
      const spanOf = (i: number) => noteSpan(notes[i], this.noteEdit(track, notes[i]));
      const MIN = 0.05;
      const lo = drag.index > 0 ? spanOf(drag.index - 1).start + MIN : 0;
      const hi = drag.index + 1 < notes.length ? spanOf(drag.index + 1).end - MIN : take.meta.duration;
      const grid = gridOf(project);
      const snap = (t: number) => (drag.free || !grid ? t : snapToGrid(t + track.offset, grid, 0.25, 0.01) - track.offset);
      let { start, end } = base.span;
      if (drag.kind === 'move') {
        const len = end - start;
        start = Math.min(hi - len, Math.max(lo, snap(start + drag.seconds)));
        end = start + len;
      } else if (drag.kind === 'start') start = Math.min(end - MIN, Math.max(lo, snap(start + drag.seconds)));
      else end = Math.max(start + MIN, Math.min(hi, snap(end + drag.seconds)));
      const r = (t: number) => Math.round(t * 1000) / 1000;
      const sung = cur.note;
      const asSung = Math.abs(start - sung.start) < 0.0005 && Math.abs(end - sung.end) < 0.0005;
      this.editNote(drag.index, asSung ? { start: undefined, end: undefined } : { start: r(start), end: r(end) }, key, Infinity);
    }
    if (drag.done) this.noteDragBase = null;
  }

  /** Points the roll's note blobs at the selected track (or hides them). */
  private syncNoteBlobs(): void {
    const state = this.store.get();
    const target = state.noteMode && state.mode === 'playback' ? this.editTarget() : null;
    if (!target) return this.roll.setNotes(null, null);
    const at = this.takeTimeMap(target.track, target.take);
    this.roll.setNotes(
      target.notes.map((n) => {
        const edit = this.noteEdit(target.track, n);
        return { from: n.from, to: n.to, start: at(n.start) + target.track.offset, end: at(n.end) + target.track.offset, edited: !!edit };
      }),
      state.selectedNote,
    );
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
      for (const t of restored.tracks) this.updateTrackVoice(t.id);
    });
  }

  private publishHistory(): void {
    this.store.set({ history: { canUndo: this.history.canUndo, canRedo: this.history.canRedo } });
  }

  /**
   * Changes a song. For the open song the change is recorded for undo, unless `historyKey` is false;
   * edits with the same key in quick succession (a drag) become one undo step.
   */
  private mutateProject(id: string, fn: (p: Project) => Project, historyKey: string | null | false = null, windowMs?: number): void {
    const before = this.store.get().projects.find((p) => p.id === id);
    if (before && historyKey !== false && id === this.store.get().projectId) {
      this.history.push(before, historyKey, Date.now(), windowMs);
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
    // As heard: moved by note timing edits, shifted by each track's offset and transposed by its
    // pitch + the song's key shift.
    const shifted = (t: Track) => {
      const take = t.takeId ? this.takes.get(t.takeId) : undefined;
      if (!take) return [];
      const st = trackSemitones(t, project);
      const at = this.takeTimeMap(t, take);
      return take.frames.map((f) => ({ ...f, time: at(f.time) + t.offset, midi: f.midi === null ? null : f.midi + st }));
    };
    this.roll.setTuning(this.rollTuning());
    this.roll.setGrid(gridOf(project));
    this.roll.setScaleHint(project.key ? transposeScale(project.key, project.keyShift) : null);
    const selected = project.tracks.find((t) => t.id === state.selectedTrackId);
    // Ghosts show other tracks' pitch edits too (their lines are drawn from the sung pitch).
    this.roll.setGhosts(
      project.tracks
        .filter((t) => t !== selected && t.kind === 'vocal')
        .map((t) => {
          const frames = shifted(t);
          const edits = t.noteEdits ?? [];
          if (!edits.length) return { frames, hue: t.hue };
          const moved = frames.map((f) => ({ ...f }));
          for (const e of edits) for (let i = e.from; i < Math.min(e.to, moved.length); i++) if (moved[i].midi !== null) moved[i].midi! += e.shift;
          return { frames: moved, hue: t.hue };
        }),
    );
    this.roll.setNoteEdits(selected?.noteEdits ?? []);
    // Keys recorded with the track: drawn as its harmony lines (by the take's own frame times).
    const keyTake = selected?.keys?.events.length && selected.takeId ? this.takes.get(selected.takeId) : undefined;
    this.roll.setKeyHarmony(
      keyTake && selected?.keys ? { voicing: selected.keys.voicing, at: (i) => keysAt(selected.keys!.events, keyTake.frames[i]?.time ?? 0) } : null,
    );
    // While editing notes the view stays put (it would jump as notes move).
    this.roll.showRecording(selected ? shifted(selected) : [], this.player.duration, this.player.currentTime, state.noteMode);
    this.syncNoteBlobs();
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
        if (bpm) {
          // The tempo and where the bars start (so the click and grid line up with the beat).
          const downbeat = normalizeDownbeat(analysis.tempo!.downbeat, { bpm, beatsPerBar: 4, downbeat: 0 });
          this.mutateProject(project.id, (p) => ({ ...p, bpm, beatsPerBar: 4, downbeat, updatedAt: Date.now() }), false);
          if (this.store.get().projectId === project.id) this.tempoChanged();
        }
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
    onUpdate: (change: VoiceChange) => void,
  ): void {
    const rate = this.player.context.sampleRate;
    const key = JSON.stringify([take.meta.id, rate]);
    const first = settingsOf();
    if (!first) {
      const had = voice.plans !== null;
      voice.plans = null; // the preparation is kept, for when something is switched back on
      setRender({ busy: false, ready: false, notes: [] });
      if (had) onUpdate('plans');
      onUpdate('cleanup');
      // Nothing to do yet, but prepare the take quietly so the first change is instant too. (A
      // preparation already on its way is left to finish: its plans are dropped when it lands.)
      if (key === voice.sentKey) return;
    }
    // Clean-up settings go straight to the engine: heard on the next block.
    if (first && voice.cleanup) {
      setRender({ notes: cleanupNotes(first, voice.cleanup) });
      onUpdate('cleanup');
    }
    // Only the first request for a take prepares it (a moment); after that only plans are made.
    if (first && key !== voice.sentKey) setRender({ busy: true });
    this.debounce(channel, 0, async () => {
      if (!isCurrent()) return;
      const settings = settingsOf() ?? NOTHING;
      const prepare =
        key !== voice.sentKey ? { key, samples: take.samples, sampleRate: take.meta.sampleRate, targetRate: rate, frames: take.frames } : undefined;
      voice.sentKey = key;
      try {
        const r = await this.renderer.voice(channel, {
          prepare,
          tune: settings.tune,
          semitones: settings.pitch ?? 0,
          voice: settings.voice,
          notes: settings.notes,
          keys: settings.keys,
          have: voice.version,
        });
        if (!r || !isCurrent()) return; // superseded, removed or closed
        const prepared = r.version !== voice.version;
        if (prepared) {
          voice.version = r.version;
          voice.source = r.source ?? (take.meta.sampleRate === rate ? take.samples : null);
          voice.cleanup = r.cleanup ?? voice.cleanup;
        }
        voice.plans = settingsOf() ? r.plans : null;
        const now = settingsOf();
        setRender({ ready: true, notes: now && voice.cleanup ? cleanupNotes(now, voice.cleanup) : [] });
        onUpdate(prepared ? 'prepared' : 'plans');
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
      (change) => {
        this.updatePreviewSource();
        if (change !== 'cleanup' && this.playWhenProcessed) {
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
    const state = this.store.get();
    const settings = processSettingsOf(state.tuning, state.cleanup);
    if (wantsProcessed(state) && settings && v.source) {
      this.player.swap(v.source, this.player.context.sampleRate, v.plans, v.cleanup, cleanupSettingsOf(settings));
    } else {
      this.player.swap(rec.samples, rec.meta.sampleRate, null);
    }
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
      (change) => {
        if (change === 'prepared') return this.rebuildMix();
        const listen = this.store.get().listenProcessed;
        if (change === 'plans') return this.player.setPlans(trackId, listen ? voice.plans : null);
        const p = openProject(this.store.get());
        const t = p?.tracks.find((x) => x.id === trackId);
        const settings = p && t ? trackProcessSettings(t, p) : null;
        this.player.setCleanup(trackId, listen && settings ? cleanupSettingsOf(settings) : CLEANUP_OFF);
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
        const buffer = t.assetId ? this.assets.get(t.assetId) : undefined;
        if (buffer) {
          specs.push({
            id: t.id,
            samples: EMPTY,
            sampleRate: buffer.sampleRate,
            buffer,
            shift: project.keyShift,
            gain: effectiveGain(t, project.tracks),
            pan: t.pan,
            offset: t.offset,
          });
        }
        continue;
      }
      const take = t.takeId ? this.takes.get(t.takeId) : undefined;
      if (!take) continue;
      const voice = this.voices.get(t.id);
      const settings = trackProcessSettings(t, project);
      const processed = listen && settings && voice?.source ? voice : null;
      specs.push({
        id: t.id,
        samples: processed ? processed.source! : take.samples,
        sampleRate: processed ? rate : take.meta.sampleRate,
        plans: processed ? processed.plans : null,
        cleanup: processed ? processed.cleanup : null,
        cleanupSettings: processed && settings ? cleanupSettingsOf(settings) : CLEANUP_OFF,
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
    this.syncMetronome();
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
