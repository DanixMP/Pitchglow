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
import { MixPlayer, type MixTrackSpec } from '../audio/mix-player';
import { renderMix } from '../audio/mixdown';
import { PitchTracker, type PitchFrame } from '../audio/pitch-tracker';
import { SampleBuffer } from '../audio/sample-buffer';
import { TunedRenderer } from '../audio/tuned-renderer';
import { wavBlob, wavBlobChannels } from '../audio/wav';
import {
  addTrack,
  createProject,
  createVocalTrack,
  duplicateProject as duplicateProjectModel,
  effectiveGain,
  nextProjectName,
  removeTrack as removeTrackModel,
  updateTrack as updateTrackModel,
  withoutTake,
  type Project,
  type Track,
} from '../project/model';
import { packFrames, unpackFrames } from '../storage/pitch-track';
import { RecordingStore, type RecordingMeta } from '../storage/recording-store';
import type { CleanupPrefs, TuningPrefs } from '../storage/settings';
import type { PianoRoll } from '../ui/piano-roll';
import { processedLabelOf, processSettingsOf, tuneSettingsOf, wantsProcessed } from './processing';
import { openProject, type AppStore, type RenderState } from './state';

const MIN_RECORDING_SECONDS = 0.3;
const PREVIEW_CHANNEL = 'preview';
const SAVE_DELAY_MS = 400;

interface LoadedTake {
  meta: RecordingMeta;
  samples: Float32Array;
  frames: PitchFrame[];
}

/** Processed render of a take (preview) or a track (song), and the settings it was rendered with. */
interface Rendered {
  processed: Float32Array | null;
  processedFor: string | null;
}

export class Session {
  readonly player = new MixPlayer();
  private readonly input = new AudioInput((block) => this.onBlock(block));
  private readonly renderer = new TunedRenderer();
  private db: RecordingStore | null = null;

  private sampleRate = 0;
  private tracker: PitchTracker | null = null;
  private take: { audio: SampleBuffer; frames: PitchFrame[] } | null = null;

  /** Take preview (no song open). */
  private preview: (LoadedTake & Rendered) | null = null;
  /** Loaded takes (audio + pitch) for the open song, by take id. */
  private takes = new Map<string, LoadedTake>();
  /** Processed renders for the open song, by track id. */
  private trackAudio = new Map<string, Rendered>();
  private renderTimers = new Map<string, number>();
  /** Global settings, stashed while a song's track settings occupy the inspector. */
  private stash: { tuning: TuningPrefs; cleanup: CleanupPrefs } | null = null;
  private saveTimers = new Map<string, number>();

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
    const db = await this.getDb();
    const [recordings, projects] = await Promise.all([db.list(), db.listProjects()]);
    this.store.set({ recordings, projects });
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
    this.store.set({ mode: this.store.get().projectId ? 'playback' : 'idle' });
    if (finished) await this.saveTake(finished);
    else if (this.store.get().projectId) this.refreshSongView();
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
      this.addTrackFromTake(meta, tuning, cleanup);
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
    this.preview = { ...take, processed: null, processedFor: null };
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
    this.schedulePreviewRender(0);
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
          for (const id of [...this.trackAudio.keys()]) if (!open.tracks.some((t) => t.id === id)) this.trackAudio.delete(id);
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
      downloadBlob(wavBlob(take.samples, take.meta.sampleRate), take.meta.name);
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
        const rate = Math.max(...specs.map((s) => s.sampleRate));
        const mix = await renderMix(specs, rate);
        downloadBlob(wavBlobChannels(mix.channels, mix.sampleRate), `${project.name} (mix)`);
      });
    } else if (this.preview?.processed) {
      const label = processedLabelOf(state.tuning, state.cleanup).toLowerCase();
      downloadBlob(wavBlob(this.preview.processed, this.preview.meta.sampleRate), `${this.preview.meta.name} (${label})`);
    }
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
    for (const t of project.tracks) if (t.takeId) await this.loadTake(t.takeId);

    const { tuning, cleanup } = this.store.get();
    this.stash = { tuning, cleanup };
    const first = project.tracks.find((t) => t.kind === 'vocal') ?? null;
    this.store.set({ projectId: id, selectedTrackId: null, mode: 'playback', trackRender: {} });
    this.player.unload();
    this.selectTrack(first?.id ?? null);
    this.rebuildMix();
    this.player.seek(0);
    for (const t of project.tracks) this.scheduleTrackRender(t.id, 0);
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
    this.cancelRender();
    for (const t of this.renderTimers.values()) window.clearTimeout(t);
    this.renderTimers.clear();
    this.trackAudio.clear();
    this.player.unload();
    this.roll.clear();
    const stash = this.stash;
    this.stash = null;
    this.store.set({
      projectId: null,
      selectedTrackId: null,
      trackRender: {},
      duration: 0,
      mode: 'idle',
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

  /** Adds a library take to the open song as a new vocal track (with the global default settings). */
  addTakeToProject(takeId: string): void {
    this.run(async () => {
      if (!this.store.get().projectId) return;
      const take = await this.loadTake(takeId);
      const defaults = this.stash ?? { tuning: this.store.get().tuning, cleanup: this.store.get().cleanup };
      this.addTrackFromTake(take.meta, defaults.tuning, defaults.cleanup);
    });
  }

  private addTrackFromTake(meta: RecordingMeta, tuning: TuningPrefs, cleanup: CleanupPrefs): void {
    const project = openProject(this.store.get());
    if (!project) return;
    const track = createVocalTrack(meta, tuning, cleanup, project.tracks);
    this.mutateProject(project.id, (p) => addTrack(p, track));
    this.selectTrack(track.id);
    this.rebuildMix();
    this.scheduleTrackRender(track.id, 0);
  }

  removeTrack(trackId: string): void {
    const project = openProject(this.store.get());
    if (!project) return;
    this.cancelRender(trackId);
    this.trackAudio.delete(trackId);
    this.mutateProject(project.id, (p) => removeTrackModel(p, trackId));
    if (this.store.get().selectedTrackId === trackId) {
      const next = openProject(this.store.get())?.tracks[0]?.id ?? null;
      this.selectTrack(next);
    }
    this.rebuildMix();
  }

  /** Selects a track: its settings move into the inspector, its pitch line into the roll. */
  selectTrack(trackId: string | null): void {
    const state = this.store.get();
    const project = openProject(state);
    const track = project?.tracks.find((t) => t.id === trackId) ?? null;
    const base = this.stash ?? { tuning: state.tuning, cleanup: state.cleanup };
    this.store.set({
      selectedTrackId: track?.id ?? null,
      // No track selected: the inspector shows the global defaults (used for new tracks).
      tuning: track ? track.tuning : base.tuning,
      cleanup: track ? { ...track.cleanup, micFilter: state.cleanup.micFilter } : { ...base.cleanup, micFilter: state.cleanup.micFilter },
    });
    this.refreshSongView();
  }

  /** Mix changes from the track list (fader, mute, solo, name): applied live, saved shortly after. */
  updateTrackMix(trackId: string, patch: Partial<Pick<Track, 'gainDb' | 'mute' | 'solo' | 'name'>>): void {
    const project = openProject(this.store.get());
    if (!project) return;
    this.mutateProject(project.id, (p) => updateTrackModel(p, trackId, patch));
    const tracks = openProject(this.store.get())!.tracks;
    for (const t of tracks) this.player.setGain(t.id, effectiveGain(t, tracks));
  }

  private mutateProject(id: string, fn: (p: Project) => Project): void {
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
    const shifted = (t: Track) => {
      const take = t.takeId ? this.takes.get(t.takeId) : undefined;
      return take ? take.frames.map((f) => ({ ...f, time: f.time + t.offset })) : [];
    };
    const selected = project.tracks.find((t) => t.id === state.selectedTrackId);
    this.roll.setGhosts(project.tracks.filter((t) => t !== selected && t.kind === 'vocal').map((t) => ({ frames: shifted(t), hue: t.hue })));
    this.roll.showRecording(selected ? shifted(selected) : [], this.player.duration, this.player.currentTime);
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
    this.roll.setTuning(tuneSettingsOf(state.tuning));
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
    this.mutateProject(state.projectId, (p) => updateTrackModel(p, track.id, { tuning: state.tuning, cleanup }));
    this.scheduleTrackRender(track.id);
  }

  /** The global defaults while a song is open (for saving prefs); the inspector settings otherwise. */
  globalSettings(): { tuning: TuningPrefs; cleanup: CleanupPrefs } {
    const { tuning, cleanup } = this.store.get();
    return this.stash ? { tuning: this.stash.tuning, cleanup: { ...this.stash.cleanup, micFilter: cleanup.micFilter } } : { tuning, cleanup };
  }

  // --- processed audio: take preview ----------------------------------------------------------

  private schedulePreviewRender(delay = 120): void {
    const rec = this.preview;
    if (!rec) return;
    const { tuning, cleanup } = this.store.get();
    const settings = processSettingsOf(tuning, cleanup);
    if (!settings) {
      this.cancelRender(PREVIEW_CHANNEL);
      this.updatePreviewSource();
      this.setPreviewRender({ busy: false });
      return;
    }
    const key = JSON.stringify(settings);
    if (rec.processedFor === key) return;
    this.setPreviewRender({ busy: true });
    this.debounce(PREVIEW_CHANNEL, delay, async () => {
      try {
        const out = await this.renderer.render(PREVIEW_CHANNEL, rec.meta.id, rec.samples, rec.meta.sampleRate, rec.frames, settings);
        if (!out || this.preview !== rec) return; // superseded or closed
        rec.processed = out.output;
        rec.processedFor = key;
        this.setPreviewRender({ ready: true, notes: out.notes });
        this.updatePreviewSource();
      } catch (err) {
        console.error(err);
        this.store.set({ status: describeError(err) });
      } finally {
        if (this.preview === rec && !this.renderer.busy(PREVIEW_CHANNEL)) {
          this.setPreviewRender({ busy: false });
          if (this.playWhenProcessed) {
            this.playWhenProcessed = false;
            void this.player.play();
          }
        }
      }
    });
  }

  private setPreviewRender(patch: Partial<RenderState>): void {
    this.store.set((s) => ({ render: { ...s.render, ...patch } }));
  }

  /** Points the player at the processed or original take, keeping position and play state. */
  private updatePreviewSource(): void {
    const rec = this.preview;
    if (!rec) return;
    const next = wantsProcessed(this.store.get()) && rec.processed ? rec.processed : rec.samples;
    this.player.swap(next, rec.meta.sampleRate);
  }

  // --- processed audio: song tracks -----------------------------------------------------------

  private scheduleTrackRender(trackId: string, delay = 120): void {
    const project = openProject(this.store.get());
    const track = project?.tracks.find((t) => t.id === trackId);
    const take = track?.takeId ? this.takes.get(track.takeId) : undefined;
    if (!project || !track || !take) return;
    const settings = processSettingsOf(track.tuning, { ...track.cleanup, micFilter: false });
    const audio = this.trackAudio.get(trackId) ?? { processed: null, processedFor: null };
    this.trackAudio.set(trackId, audio);
    if (!settings) {
      this.cancelRender(trackId);
      this.setTrackRender(trackId, { busy: false });
      this.rebuildMix();
      return;
    }
    const key = JSON.stringify(settings);
    if (audio.processedFor === key) return;
    this.setTrackRender(trackId, { busy: true });
    this.debounce(trackId, delay, async () => {
      try {
        const out = await this.renderer.render(trackId, take.meta.id, take.samples, take.meta.sampleRate, take.frames, settings);
        if (!out || this.trackAudio.get(trackId) !== audio) return; // superseded, removed or closed
        audio.processed = out.output;
        audio.processedFor = key;
        this.setTrackRender(trackId, { ready: true, notes: out.notes });
        this.rebuildMix();
      } catch (err) {
        console.error(err);
        this.store.set({ status: describeError(err) });
      } finally {
        if (!this.renderer.busy(trackId)) this.setTrackRender(trackId, { busy: false });
      }
    });
  }

  private setTrackRender(trackId: string, patch: Partial<RenderState>): void {
    this.store.set((s) => ({
      trackRender: { ...s.trackRender, [trackId]: { ...(s.trackRender[trackId] ?? { busy: false, ready: false, notes: [] }), ...patch } },
    }));
  }

  /** The audio each track should play right now (processed when ready and wanted, else original). */
  private mixSpecs(project: Project): MixTrackSpec[] {
    const listen = this.store.get().listenProcessed;
    const specs: MixTrackSpec[] = [];
    for (const t of project.tracks) {
      const take = t.takeId ? this.takes.get(t.takeId) : undefined;
      if (!take) continue;
      const audio = this.trackAudio.get(t.id);
      const processedWanted = listen && processSettingsOf(t.tuning, { ...t.cleanup, micFilter: false }) !== null;
      const samples = processedWanted && audio?.processed ? audio.processed : take.samples;
      specs.push({ id: t.id, samples, sampleRate: take.meta.sampleRate, gain: effectiveGain(t, project.tracks), offset: t.offset });
    }
    return specs;
  }

  private rebuildMix(): void {
    const project = openProject(this.store.get());
    if (!project) return;
    this.player.setTracks(this.mixSpecs(project));
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

  private cancelRender(channel?: string): void {
    if (channel !== undefined) {
      window.clearTimeout(this.renderTimers.get(channel));
      this.renderTimers.delete(channel);
    }
    this.renderer.cancel(channel);
  }
}

function nextRecordingName(recordings: readonly RecordingMeta[]): string {
  const used = recordings.map((r) => /^Recording (\d+)$/.exec(r.name)?.[1]).filter(Boolean).map(Number);
  return `Recording ${Math.max(0, ...used) + 1}`;
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
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
