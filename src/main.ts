import { AudioInput, type InputKind } from './audio/audio-input';
import { Player } from './audio/player';
import { PitchTracker, type PitchFrame } from './audio/pitch-tracker';
import { SampleBuffer } from './audio/sample-buffer';
import { TunedRenderer } from './audio/tuned-renderer';
import { wavBlob } from './audio/wav';
import type { TuneSettings } from './dsp/autotune';
import type { ProcessSettings } from './dsp/process';
import { nearestNote, noteName, pitchClassName } from './dsp/notes';
import { HARMONY_VOICES, type HarmonyVoice } from './dsp/harmony';
import { SCALE_TYPES, scaleName, type ScaleType } from './dsp/scales';
import { packFrames, unpackFrames } from './storage/pitch-track';
import { RecordingStore, type RecordingMeta } from './storage/recording-store';
import { DEFAULT_TUNING, loadCleanup, loadTuning, saveCleanup, saveTuning } from './storage/settings';
import { Captions } from './ui/captions';
import { formatTime } from './ui/format';
import { Knob } from './ui/knob';
import { PianoRoll } from './ui/piano-roll';
import { setupPwa } from './pwa';
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
  exportProcessed: $<HTMLButtonElement>('export-tuned'),
  exportProcessedLabel: $('export-tuned').querySelector('span')!,
  denoiseOn: $<HTMLInputElement>('denoise-on'),
  denoiseAmount: $<HTMLInputElement>('denoise-amount'),
  denoiseAmountField: $('denoise-amount-field'),
  denoiseAmountValue: $('denoise-amount-value'),
  micFilter: $<HTMLInputElement>('mic-filter'),
  harmonyVoices: $('harmony-voices'),
  harmonyMix: $<HTMLInputElement>('harmony-mix'),
  harmonyMixValue: $('harmony-mix-value'),
};

/** idle → listening/recording (live input) or playback (a saved recording is open). */
type Mode = 'idle' | 'listening' | 'recording' | 'playback';

interface LoadedRecording {
  meta: RecordingMeta;
  samples: Float32Array;
  frames: PitchFrame[];
}

interface OpenRecording extends LoadedRecording {
  /** Processed render of `samples` (cleaned and/or tuned), and the settings it was rendered with. */
  processed: Float32Array | null;
  processedFor: string | null;
  /** Notes from the last render (e.g. "Too short to learn the noise"). */
  notes: string[];
}

const MIN_RECORDING_SECONDS = 0.3;

const roll = new PianoRoll($<HTMLCanvasElement>('roll'));
const captions = new Captions($('caption'));
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
let cleanup = loadCleanup();
/** A/B: play the processed render (when anything is switched on) or the original. */
let listenProcessed = true;
/** Start playback once the processed render arrives (Play pressed on a just-opened recording). */
let playWhenProcessed = false;
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
  const micFilter = source === 'mic' && cleanup.micFilter;
  if (input.kind !== source || input.noiseSuppression !== micFilter) {
    sampleRate = await input.start(source, { noiseSuppression: micFilter });
  }
  tracker = new PitchTracker(sampleRate, onFrame);
  take = record ? { audio: new SampleBuffer(), frames: [] } : null;
  roll.start();
  setMode(record ? 'recording' : 'listening');
  explainIntro();
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
  open = { ...rec, processed: null, processedFor: null, notes: [] };
  player.load(rec.samples, rec.meta.sampleRate);
  playerSource = rec.samples;
  // Start "at the end" so the last few seconds are visible; Play restarts from the beginning.
  player.seek(autoplay ? 0 : rec.meta.duration);
  roll.showRecording(rec.frames, rec.meta.duration, player.currentTime);
  ui.seek.max = String(rec.meta.duration);
  ui.timeTotal.textContent = formatTime(rec.meta.duration);
  setMode('playback');
  renderList();
  // If we're going to listen to the processed version, wait for it rather than switching mid-play.
  playWhenProcessed = autoplay && wantsProcessed();
  scheduleRender(0);
  if (autoplay && !playWhenProcessed) void player.play();
  updateAbUi();
}

function closeRecording(): void {
  if (!open) return;
  window.clearTimeout(renderTimer);
  renderer.cancel();
  playWhenProcessed = false;
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

// --- processed audio: noise reduction + auto-tune + harmony (Phases 4-6) ---------------------

/** What the worker should do to the open recording, or null when nothing is switched on. */
function processSettings(): ProcessSettings | null {
  const tune = tuneSettings();
  const denoise = cleanup.denoise ? { amountDb: cleanup.denoiseDb } : null;
  return tune || denoise ? { tune, denoise } : null;
}

/** Name for the processed version, used on the A/B switch, heading and export. */
function processedLabel(): string {
  if (tuning.enabled && cleanup.denoise) return 'Clean + tuned';
  if (cleanup.denoise) return 'Cleaned';
  return 'Tuned';
}

function wantsProcessed(): boolean {
  return listenProcessed && processSettings() !== null;
}

/** (Re-)renders the open recording's processed audio in the worker; debounced while controls move. */
function scheduleRender(delay = 120): void {
  window.clearTimeout(renderTimer);
  const rec = open;
  if (!rec) return;
  const settings = processSettings();
  if (!settings) {
    renderer.cancel();
    updatePlaybackSource();
    updateAbUi();
    return;
  }
  const key = JSON.stringify(settings);
  if (rec.processedFor === key) return;
  ui.renderStatus.textContent = 'Processing…';
  renderTimer = window.setTimeout(async () => {
    try {
      const out = await renderer.render(rec.meta.id, rec.samples, rec.meta.sampleRate, rec.frames, settings);
      if (!out || open !== rec) return; // superseded or closed
      rec.processed = out.output;
      rec.processedFor = key;
      rec.notes = out.notes;
      updatePlaybackSource();
    } catch (err) {
      console.error(err);
      showStatus(describeError(err));
    } finally {
      if (open === rec && !renderer.busy) {
        updateAbUi();
        if (playWhenProcessed) {
          playWhenProcessed = false;
          void player.play();
        }
      }
    }
  }, delay);
}

/** Points the player at the processed or original audio, keeping position and play state. */
function updatePlaybackSource(): void {
  if (!open) return;
  const next = wantsProcessed() && open.processed ? open.processed : open.samples;
  if (next === playerSource) return;
  player.swap(next, open.meta.sampleRate);
  playerSource = next;
}

function updateAbUi(): void {
  const available = processSettings() !== null;
  const label = processedLabel();
  for (const btn of ui.abButtons) {
    const isProcessed = btn.dataset.ab === 'tuned';
    const on = isProcessed === wantsProcessed();
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-checked', String(on));
    if (isProcessed) {
      btn.disabled = !available;
      btn.textContent = label;
    }
  }
  ui.exportProcessed.disabled = !(available && open?.processed);
  ui.exportProcessedLabel.textContent = `${label} WAV`;
  ui.renderStatus.textContent = !available
    ? 'Auto-tune and noise reduction are off'
    : renderer.busy
      ? 'Processing…'
      : (open?.notes ?? []).join(' · ');
}

function setListenProcessed(on: boolean): void {
  listenProcessed = on;
  updatePlaybackSource();
  updateAbUi();
  updateHeading();
  explainListenMode();
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
  ui.micFilter.disabled = mode === 'recording'; // changing it mid-take would change the recording's sound
  if (live) showStatus('');
  updateHeading();
}

/** Title card for the current tuning, in the style of Goal.mp4's headings. */
function headingCard(): { eyebrow: string; title: string; tone: 'tuned' | 'scale' | 'harmony' | null } {
  if (!tuning.enabled) return { eyebrow: 'Live pitch', title: 'My voice', tone: null };
  if (tuning.harmony.length) return { eyebrow: 'One voice, many notes', title: 'A harmonizer', tone: 'harmony' };
  if (tuning.type !== 'chromatic') return { eyebrow: 'Only', title: scaleName({ root: tuning.root, type: tuning.type }), tone: 'scale' };
  return { eyebrow: 'Nearest note', title: 'On auto-tune', tone: 'tuned' };
}

function updateHeading(): void {
  const card = headingCard();
  let { eyebrow, title, tone } = card;
  if (mode === 'recording') {
    eyebrow = `● Recording ${formatTime((take?.audio.length ?? 0) / sampleRate)}`;
  } else if (mode === 'playback' && open) {
    eyebrow = processSettings() ? `Playback · ${wantsProcessed() ? processedLabel() : 'Original'}` : 'Playback';
    title = open.meta.name;
    tone = null;
  }
  ui.eyebrow.textContent = eyebrow;
  ui.title.textContent = title;
  ui.eyebrow.classList.toggle('is-recording', mode === 'recording');
  ui.title.classList.toggle('is-tuned', tone === 'tuned');
  ui.title.classList.toggle('is-scale', tone === 'scale');
  ui.title.classList.toggle('is-harmony', tone === 'harmony');
}

// --- explainer captions ------------------------------------------------------------------------

const INTRO_KEY = 'recorder.introSeen';
let retuneCaptionTimer = 0;

function explainIntro(): void {
  try {
    if (localStorage.getItem(INTRO_KEY)) return;
    localStorage.setItem(INTRO_KEY, '1');
  } catch {
    return;
  }
  captions.show(['Each of these lanes is one key on a piano.', 'As you sing, this line follows the pitch of your voice.']);
}

function explainTuningSwitch(): void {
  captions.show(tuning.enabled ? 'Auto-tune snaps your voice to the nearest note.' : 'This is your voice, untouched.');
}

function explainRetune(): void {
  window.clearTimeout(retuneCaptionTimer);
  retuneCaptionTimer = window.setTimeout(() => {
    const ms = tuning.retuneMs;
    captions.show(
      ms === 0
        ? '0 ms: it jumps the instant you move. That’s the robot sound.'
        : ms < 100
          ? `${ms} ms: it snaps quickly onto each note.`
          : `${ms} ms: set it gently, and it glides into each note.`,
    );
  }, 350);
}

function explainScale(): void {
  captions.show(
    tuning.type === 'chromatic'
      ? 'Chromatic: it can land on any key.'
      : `Only ${scaleName({ root: tuning.root, type: tuning.type })}: it can only land on these notes.`,
  );
}

function explainHarmony(): void {
  captions.show(tuning.harmony.length ? 'One voice, many notes: every lit key is a voice.' : 'Harmony off: just your voice.');
}

function explainListenMode(): void {
  if (!wantsProcessed()) captions.show('Original: exactly what you sang.');
  else if (tuning.enabled) captions.show(cleanup.denoise ? 'Cleaned and tuned: no hiss, on pitch.' : 'Tuned: your voice, on pitch.');
  else captions.show('Cleaned: your voice, without the background noise.');
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
  if (!tuning.enabled) return null;
  const settings: TuneSettings = { scale: { root: tuning.root, type: tuning.type }, retuneMs: tuning.retuneMs };
  if (tuning.harmony.length) settings.harmony = { voices: [...tuning.harmony], mix: tuning.harmonyMix };
  return settings;
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
  for (const chip of harmonyChips) {
    chip.setAttribute('aria-pressed', String(tuning.harmony.includes(chip.dataset.voice as HarmonyVoice)));
    chip.disabled = !tuning.enabled;
  }
  ui.harmonyMix.value = String(Math.round(tuning.harmonyMix * 100));
  ui.harmonyMix.disabled = !tuning.enabled || tuning.harmony.length === 0;
  ui.harmonyMixValue.textContent = `${Math.round(tuning.harmonyMix * 100)}%`;
  updateHeading();
  scheduleRender();
  updateAbUi();
}

const harmonyChips = (Object.keys(HARMONY_VOICES) as HarmonyVoice[]).map((voice) => {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'chip';
  chip.dataset.voice = voice;
  chip.textContent = HARMONY_VOICES[voice].label;
  chip.addEventListener('click', () => {
    const on = tuning.harmony.includes(voice);
    // Keep voices in a stable (menu) order so the render cache key doesn't depend on click order.
    const next = (Object.keys(HARMONY_VOICES) as HarmonyVoice[]).filter((v) => (v === voice ? !on : tuning.harmony.includes(v)));
    tuning = { ...tuning, harmony: next };
    applyTuning();
    explainHarmony();
  });
  ui.harmonyVoices.append(chip);
  return chip;
});
ui.harmonyMix.addEventListener('input', () => {
  tuning = { ...tuning, harmonyMix: Number(ui.harmonyMix.value) / 100 };
  applyTuning();
});

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
    explainRetune();
  },
});
$('retune-knob').replaceWith(knob.element);

ui.tuneOn.addEventListener('change', () => {
  tuning = { ...tuning, enabled: ui.tuneOn.checked };
  applyTuning();
  explainTuningSwitch();
});
ui.tuneKey.addEventListener('change', () => {
  tuning = { ...tuning, root: Number(ui.tuneKey.value) };
  applyTuning();
  explainScale();
});
ui.tuneScale.addEventListener('change', () => {
  tuning = { ...tuning, type: ui.tuneScale.value as ScaleType };
  applyTuning();
  explainScale();
});

// --- clean-up settings (Phase 6) ---------------------------------------------------------------

let denoiseCaptionTimer = 0;

/** Pushes clean-up prefs to the controls, re-renders the open recording and saves them. */
function applyCleanup(): void {
  saveCleanup(cleanup);
  ui.denoiseOn.checked = cleanup.denoise;
  ui.denoiseAmount.value = String(cleanup.denoiseDb);
  ui.denoiseAmount.disabled = !cleanup.denoise;
  ui.denoiseAmountField.classList.toggle('is-off', !cleanup.denoise);
  ui.denoiseAmountValue.textContent = `${cleanup.denoiseDb} dB`;
  ui.micFilter.checked = cleanup.micFilter;
  ui.micFilter.disabled = mode === 'recording';
  scheduleRender();
  updateAbUi();
  updateHeading();
}

ui.denoiseOn.addEventListener('change', () => {
  cleanup = { ...cleanup, denoise: ui.denoiseOn.checked };
  applyCleanup();
  captions.show(
    cleanup.denoise ? 'Noise reduction: it learns the hiss from your pauses and removes it.' : 'Noise reduction off.',
  );
});
ui.denoiseAmount.addEventListener('input', () => {
  cleanup = { ...cleanup, denoiseDb: Number(ui.denoiseAmount.value) };
  applyCleanup();
  window.clearTimeout(denoiseCaptionTimer);
  denoiseCaptionTimer = window.setTimeout(() => {
    const db = cleanup.denoiseDb;
    captions.show(
      db <= 9
        ? `${db} dB: a light touch, the room still breathes.`
        : db <= 18
          ? `${db} dB: background noise pushed well back.`
          : `${db} dB: aggressive. Listen for a watery sound.`,
    );
  }, 350);
});
ui.micFilter.addEventListener('change', () =>
  run(async () => {
    cleanup = { ...cleanup, micFilter: ui.micFilter.checked };
    applyCleanup();
    // Restart a running mic so the browser's filter takes effect now.
    if (mode === 'listening' && source === 'mic') await startLive(false);
    captions.show(
      cleanup.micFilter
        ? 'Mic noise filter on: the browser cleans the mic live, and it is baked into new recordings.'
        : 'Mic noise filter off: raw mic.',
    );
  }),
);

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
for (const btn of ui.abButtons) btn.addEventListener('click', () => setListenProcessed(btn.dataset.ab === 'tuned'));
ui.exportProcessed.addEventListener('click', () => {
  if (open?.processed) downloadWav(open.processed, open.meta.sampleRate, `${open.meta.name} (${processedLabel().toLowerCase()})`);
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
  } else if (e.key === 'a' && mode === 'playback' && processSettings()) {
    setListenProcessed(!listenProcessed);
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

setupPwa($<HTMLButtonElement>('install'));
applyTuning();
applyCleanup();
setMode('idle');
run(refreshList);
requestAnimationFrame(frame);
