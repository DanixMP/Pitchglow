import { AudioInput, type InputKind } from './audio/audio-input';
import { Player } from './audio/player';
import { PitchTracker, type PitchFrame } from './audio/pitch-tracker';
import { SampleBuffer } from './audio/sample-buffer';
import { TunedRenderer } from './audio/tuned-renderer';
import { wavBlob } from './audio/wav';
import type { TuneSettings } from './dsp/autotune';
import { nearestNote, noteName, pitchClassName } from './dsp/notes';
import { SCALE_TYPES, type ScaleType } from './dsp/scales';
import { packFrames, unpackFrames } from './storage/pitch-track';
import { RecordingStore, type RecordingMeta } from './storage/recording-store';
import { DEFAULT_TUNING, loadTuning, saveTuning } from './storage/settings';
import { formatTime } from './ui/format';
import { Knob } from './ui/knob';
import { PianoRoll } from './ui/piano-roll';
import { RecordingsList } from './ui/recordings-list';

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
}

const ui = {
  eyebrow: $('eyebrow'),
  title: $('title'),
  note: $('note'),
  detail: $('detail'),
  status: $('status'),
  listen: $<HTMLButtonElement>('listen'),
  record: $<HTMLButtonElement>('record'),
  transport: $('transport'),
  play: $<HTMLButtonElement>('play'),
  seek: $<HTMLInputElement>('seek'),
  timeCurrent: $('time-current'),
  timeTotal: $('time-total'),
  sourceChips: [...document.querySelectorAll<HTMLButtonElement>('.source .chip')],
  tuning: $('tuning-panel'),
  tuneOn: $<HTMLInputElement>('tune-on'),
  tuneKey: $<HTMLSelectElement>('tune-key'),
  tuneScale: $<HTMLSelectElement>('tune-scale'),
  retuneValue: $('retune-value'),
  abButtons: [...document.querySelectorAll<HTMLButtonElement>('.segmented .seg')],
  renderStatus: $('render-status'),
  exportTuned: $<HTMLButtonElement>('export-tuned'),
};

/** idle → listening/recording (live input) or playback (a saved recording is open). */
type Mode = 'idle' | 'listening' | 'recording' | 'playback';

interface LoadedRecording {
  meta: RecordingMeta;
  samples: Float32Array;
  frames: PitchFrame[];
}

interface OpenRecording extends LoadedRecording {
  /** Auto-tuned render of `samples`, and the settings it was rendered with. */
  tuned: Float32Array | null;
  tunedFor: string | null;
}

const MIN_RECORDING_SECONDS = 0.3;

const roll = new PianoRoll($<HTMLCanvasElement>('roll'));
const player = new Player();
const input = new AudioInput(onBlock);
const list = new RecordingsList($('recordings'), {
  onSelect: (id) => void openRecording(id, false),
  onPlay: (id) => void openRecording(id, true),
  onRename: (id, name) => void renameRecording(id, name),
  onExport: (id) => void exportRecording(id),
  onDelete: (id) => void deleteRecording(id),
});

let mode: Mode = 'idle';
let source: InputKind = 'mic';
let store: RecordingStore | null = null;
let recordings: RecordingMeta[] = [];
let open: OpenRecording | null = null;

let sampleRate = 0;
let tracker: PitchTracker | null = null;
let take: { audio: SampleBuffer; frames: PitchFrame[] } | null = null;
/** Serialises button actions so fast double-clicks can't interleave async start/stop. */
let busy: Promise<void> = Promise.resolve();
let tuning = loadTuning();

const renderer = new TunedRenderer();
let renderTimer = 0;
/** A/B: play the tuned render (when auto-tune is on) or the original. */
let listenTuned = true;
/** Start playback once the tuned render arrives (Play pressed on a just-opened recording). */
let playWhenTuned = false;
/** The array the player currently has loaded. */
let playerSource: Float32Array | null = null;

function onBlock(block: Float32Array): void {
  take?.audio.push(block);
  tracker?.push(block);
}

function onFrame(frame: PitchFrame): void {
  take?.frames.push(frame);
  roll.push(frame);
}

function run(action: () => Promise<void>): void {
  busy = busy.then(action).catch((err) => {
    console.error(err);
    showStatus(describeError(err));
  });
}

// --- live input ------------------------------------------------------------------------------

/** Starts (or restarts) the live pitch line, optionally recording. Keeps a running input if possible. */
async function startLive(record: boolean): Promise<void> {
  closeRecording();
  if (input.kind !== source) sampleRate = await input.start(source);
  tracker = new PitchTracker(sampleRate, onFrame);
  take = record ? { audio: new SampleBuffer(), frames: [] } : null;
  roll.start();
  setMode(record ? 'recording' : 'listening');
}

async function stopLive(): Promise<void> {
  const finished = take;
  take = null;
  tracker = null;
  await input.stop();
  roll.stop();
  setMode('idle');
  if (finished) await saveTake(finished);
}

async function saveTake(t: { audio: SampleBuffer; frames: PitchFrame[] }): Promise<void> {
  const samples = t.audio.toFloat32();
  const duration = samples.length / sampleRate;
  if (duration < MIN_RECORDING_SECONDS) {
    showStatus('Recording was too short to save.');
    return;
  }
  const meta: RecordingMeta = {
    id: crypto.randomUUID(),
    name: nextRecordingName(),
    createdAt: Date.now(),
    duration,
    sampleRate,
  };
  const s = await getStore();
  await s.save(meta, { id: meta.id, samples, pitch: packFrames(t.frames) });
  void navigator.storage?.persist?.(); // ask the browser not to evict recordings under storage pressure
  recordings = await s.list();
  showRecording({ meta, samples, frames: t.frames }, false);
}

function nextRecordingName(): string {
  const used = recordings.map((r) => /^Recording (\d+)$/.exec(r.name)?.[1]).filter(Boolean).map(Number);
  return `Recording ${Math.max(0, ...used) + 1}`;
}

// --- saved recordings ------------------------------------------------------------------------

async function getStore(): Promise<RecordingStore> {
  store ??= await RecordingStore.open();
  return store;
}

async function refreshList(): Promise<void> {
  recordings = await (await getStore()).list();
  renderList();
}

function renderList(): void {
  list.render(recordings, open?.meta.id ?? null);
}

async function openRecording(id: string, autoplay: boolean): Promise<void> {
  run(async () => {
    if (mode === 'listening' || mode === 'recording') await stopLive();
    if (open?.meta.id !== id) {
      const meta = recordings.find((r) => r.id === id);
      const data = await (await getStore()).load(id);
      if (!meta || !data) throw new Error('Recording not found');
      showRecording({ meta, samples: data.samples, frames: unpackFrames(data.pitch) }, autoplay);
    } else if (autoplay) {
      player.seek(0);
      await player.play();
    }
  });
}

function showRecording(rec: LoadedRecording, autoplay: boolean): void {
  open = { ...rec, tuned: null, tunedFor: null };
  player.load(rec.samples, rec.meta.sampleRate);
  playerSource = rec.samples;
  // Start "at the end" so the last few seconds are visible; Play restarts from the beginning.
  player.seek(autoplay ? 0 : rec.meta.duration);
  roll.showRecording(rec.frames, rec.meta.duration, player.currentTime);
  ui.seek.max = String(rec.meta.duration);
  ui.timeTotal.textContent = formatTime(rec.meta.duration);
  setMode('playback');
  renderList();
  // If we're going to listen to the tuned version, wait for it rather than switching mid-play.
  playWhenTuned = autoplay && wantsTuned();
  scheduleTunedRender(0);
  if (autoplay && !playWhenTuned) void player.play();
  updateAbUi();
}

function closeRecording(): void {
  if (!open) return;
  window.clearTimeout(renderTimer);
  renderer.cancel();
  playWhenTuned = false;
  player.unload();
  playerSource = null;
  open = null;
  roll.clear();
  renderList();
}

async function renameRecording(id: string, name: string): Promise<void> {
  run(async () => {
    await (await getStore()).rename(id, name);
    if (open?.meta.id === id) open.meta = { ...open.meta, name };
    await refreshList();
    updateHeading();
  });
}

async function exportRecording(id: string): Promise<void> {
  run(async () => {
    const meta = recordings.find((r) => r.id === id);
    const samples = open?.meta.id === id ? open.samples : (await (await getStore()).load(id))?.samples;
    if (!meta || !samples) throw new Error('Recording not found');
    downloadWav(samples, meta.sampleRate, meta.name);
  });
}

function downloadWav(samples: Float32Array, sampleRate: number, name: string): void {
  const url = URL.createObjectURL(wavBlob(samples, sampleRate));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.replace(/[\\/:*?"<>|]+/g, '_')}.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// --- tuned audio (Phase 4) -------------------------------------------------------------------

function wantsTuned(): boolean {
  return listenTuned && tuning.enabled;
}

/** (Re-)renders the open recording's tuned audio in the worker; debounced while the knob turns. */
function scheduleTunedRender(delay = 120): void {
  window.clearTimeout(renderTimer);
  const rec = open;
  if (!rec) return;
  const settings = tuneSettings();
  if (!settings) {
    renderer.cancel();
    updatePlaybackSource();
    updateAbUi();
    return;
  }
  const key = JSON.stringify(settings);
  if (rec.tunedFor === key) return;
  ui.renderStatus.textContent = 'Tuning…';
  renderTimer = window.setTimeout(async () => {
    try {
      const out = await renderer.render(rec.samples, rec.meta.sampleRate, rec.frames, settings);
      if (!out || open !== rec) return; // superseded or closed
      rec.tuned = out;
      rec.tunedFor = key;
      updatePlaybackSource();
    } catch (err) {
      console.error(err);
      showStatus(describeError(err));
    } finally {
      if (open === rec && !renderer.busy) {
        updateAbUi();
        if (playWhenTuned) {
          playWhenTuned = false;
          void player.play();
        }
      }
    }
  }, delay);
}

/** Points the player at the tuned or original audio, keeping position and play state. */
function updatePlaybackSource(): void {
  if (!open) return;
  const next = wantsTuned() && open.tuned ? open.tuned : open.samples;
  if (next === playerSource) return;
  player.swap(next, open.meta.sampleRate);
  playerSource = next;
}

function updateAbUi(): void {
  const tunedReady = !!open?.tuned && tuning.enabled;
  for (const btn of ui.abButtons) {
    const isTuned = btn.dataset.ab === 'tuned';
    const on = isTuned === wantsTuned();
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-checked', String(on));
    if (isTuned) btn.disabled = !tuning.enabled;
  }
  ui.exportTuned.disabled = !tunedReady;
  ui.renderStatus.textContent = !tuning.enabled ? 'Auto-tune is off' : renderer.busy ? 'Tuning…' : '';
}

function setListenTuned(on: boolean): void {
  listenTuned = on;
  updatePlaybackSource();
  updateAbUi();
}

async function deleteRecording(id: string): Promise<void> {
  const meta = recordings.find((r) => r.id === id);
  if (!meta || !confirm(`Delete “${meta.name}”? This can’t be undone.`)) return;
  run(async () => {
    await (await getStore()).delete(id);
    if (open?.meta.id === id) {
      closeRecording();
      setMode('idle');
    }
    await refreshList();
  });
}

// --- UI state --------------------------------------------------------------------------------

function setMode(next: Mode): void {
  mode = next;
  const live = mode === 'listening' || mode === 'recording';
  ui.listen.classList.toggle('is-active', mode === 'listening');
  ui.listen.querySelector('span')!.textContent = mode === 'listening' ? 'Stop' : 'Listen';
  ui.listen.disabled = mode === 'recording';
  ui.record.classList.toggle('is-active', mode === 'recording');
  ui.record.querySelector('.label')!.textContent = mode === 'recording' ? 'Stop' : 'Record';
  ui.transport.hidden = mode !== 'playback';
  for (const chip of ui.sourceChips) {
    const on = chip.dataset.source === source;
    chip.classList.toggle('is-on', on);
    chip.setAttribute('aria-checked', String(on));
    chip.disabled = mode === 'recording';
  }
  if (live) showStatus('');
  updateHeading();
}

function updateHeading(): void {
  ui.eyebrow.classList.toggle('is-recording', mode === 'recording');
  if (mode === 'recording') {
    ui.eyebrow.textContent = `● Recording ${formatTime((take?.audio.length ?? 0) / sampleRate)}`;
    ui.title.textContent = tuning.enabled ? 'On auto-tune' : 'My voice';
  } else if (mode === 'playback' && open) {
    ui.eyebrow.textContent = 'Playback';
    ui.title.textContent = open.meta.name;
  } else {
    ui.eyebrow.textContent = 'Live pitch';
    ui.title.textContent = tuning.enabled ? 'On auto-tune' : 'My voice';
  }
  ui.title.classList.toggle('is-tuned', tuning.enabled && mode !== 'playback');
}

function updateReadout(): void {
  const frame = mode === 'idle' ? null : roll.currentFrame();
  if (frame?.midi != null && frame.freq != null) {
    // Tuned: show the note it snaps to and how far off the singing was; otherwise the nearest note.
    const { note, cents } =
      frame.target !== null ? { note: frame.target, cents: (frame.midi - frame.target) * 100 } : nearestNote(frame.midi);
    const c = Math.round(cents);
    ui.note.textContent = noteName(note);
    ui.detail.textContent = `${frame.freq.toFixed(1)} Hz · ${c >= 0 ? '+' : '−'}${Math.abs(c)}¢${frame.target !== null ? ' off' : ''}`;
  } else {
    ui.note.textContent = '–';
    ui.detail.textContent =
      mode === 'idle'
        ? 'Press Listen or Record and say something'
        : mode === 'playback'
          ? player.playing
            ? '…'
            : 'Press play, or drag the lanes to scrub'
          : 'Listening…';
  }
}

function showStatus(text: string): void {
  ui.status.textContent = text;
}

function describeError(err: unknown): string {
  if (err instanceof DOMException && err.name === 'NotAllowedError') {
    return 'Microphone access was blocked. Allow it in the browser’s site settings and try again.';
  }
  if (err instanceof DOMException && err.name === 'NotFoundError') return 'No microphone found.';
  return `Something went wrong: ${err instanceof Error ? err.message : String(err)}`;
}

// --- auto-tune settings ----------------------------------------------------------------------

function tuneSettings(): TuneSettings | null {
  return tuning.enabled ? { scale: { root: tuning.root, type: tuning.type }, retuneMs: tuning.retuneMs } : null;
}

/** Pushes the current tuning to the piano roll, the controls and localStorage. */
function applyTuning(): void {
  roll.setTuning(tuneSettings());
  saveTuning(tuning);
  ui.tuneOn.checked = tuning.enabled;
  ui.tuning.classList.toggle('is-off', !tuning.enabled);
  ui.tuneKey.value = String(tuning.root);
  ui.tuneKey.disabled = !tuning.enabled || tuning.type === 'chromatic';
  ui.tuneScale.value = tuning.type;
  ui.tuneScale.disabled = !tuning.enabled;
  knob.value = tuning.retuneMs;
  ui.retuneValue.textContent = `${tuning.retuneMs} ms`;
  ui.retuneValue.classList.toggle('is-zero', tuning.retuneMs === 0);
  updateHeading();
  scheduleTunedRender();
  updateAbUi();
}

for (let pc = 0; pc < 12; pc++) ui.tuneKey.add(new Option(pitchClassName(pc), String(pc)));
for (const [type, { label }] of Object.entries(SCALE_TYPES)) ui.tuneScale.add(new Option(label, type));

const knob = new Knob({
  min: 0,
  max: 400,
  step: 1,
  bigStep: 50,
  value: tuning.retuneMs,
  defaultValue: DEFAULT_TUNING.retuneMs,
  label: 'Retune speed',
  format: (v) => `${v} ms`,
  onInput: (v) => {
    tuning = { ...tuning, retuneMs: v };
    applyTuning();
  },
});
$('retune-knob').replaceWith(knob.element);

ui.tuneOn.addEventListener('change', () => {
  tuning = { ...tuning, enabled: ui.tuneOn.checked };
  applyTuning();
});
ui.tuneKey.addEventListener('change', () => {
  tuning = { ...tuning, root: Number(ui.tuneKey.value) };
  applyTuning();
});
ui.tuneScale.addEventListener('change', () => {
  tuning = { ...tuning, type: ui.tuneScale.value as ScaleType };
  applyTuning();
});

// --- events ----------------------------------------------------------------------------------

ui.listen.addEventListener('click', () => run(() => (mode === 'listening' ? stopLive() : startLive(false))));
ui.record.addEventListener('click', () => run(() => (mode === 'recording' ? stopLive() : startLive(true))));

for (const chip of ui.sourceChips) {
  chip.addEventListener('click', () =>
    run(async () => {
      source = chip.dataset.source as InputKind;
      if (mode === 'listening') await startLive(false); // switch the running input
      else setMode(mode);
    }),
  );
}

function togglePlay(): void {
  if (!open) return;
  if (player.playing) player.pause();
  else void player.play();
}

ui.play.addEventListener('click', togglePlay);
for (const btn of ui.abButtons) btn.addEventListener('click', () => setListenTuned(btn.dataset.ab === 'tuned'));
ui.exportTuned.addEventListener('click', () => {
  if (open?.tuned) downloadWav(open.tuned, open.meta.sampleRate, `${open.meta.name} (auto-tuned)`);
});
ui.seek.addEventListener('input', () => {
  player.seek(Number(ui.seek.value));
  roll.setTime(player.currentTime);
});
roll.onScrub = (t) => {
  player.seek(t);
  roll.setTime(t);
};

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLSelectElement) return;
  if (e.target instanceof HTMLInputElement && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
  if (e.code === 'Space' && mode === 'playback') {
    e.preventDefault();
    togglePlay();
  } else if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) {
    return;
  } else if (e.key === 'r') {
    ui.record.click();
  } else if (e.key === 't') {
    ui.tuneOn.click();
  } else if (e.key === 'a' && mode === 'playback' && tuning.enabled) {
    setListenTuned(!listenTuned);
  }
});

function frame(t: number): void {
  if (mode === 'playback') {
    const time = player.currentTime;
    roll.setTime(time);
    ui.seek.value = String(time);
    ui.timeCurrent.textContent = formatTime(time);
    ui.play.classList.toggle('is-playing', player.playing);
    ui.play.setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
  } else if (mode === 'recording') {
    updateHeading();
  }
  roll.render(t);
  updateReadout();
  requestAnimationFrame(frame);
}

applyTuning();
setMode('idle');
run(refreshList);
requestAnimationFrame(frame);
